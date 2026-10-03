/** Connector-neutral live battery. Inject a transport bound to Sparky's 13 MCP tools.
 * Does not read credentials, stop the app, or access its database.
 * Persist every checkpoint so interrupted runs can resume cleanup by owned ID.
 */
export async function runLiveBattery(transport, state, checkpoint = async () => {}) {
  const start = Date.now();
  const prefix = state.prefix;
  state.cases ??= []; state.commands ??= []; state.ids ??= [];
  const save = async () => checkpoint(state);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children ?? [])]);
  const ownedIds = new Set();
  function rememberCreation(command) {
    const value = command?.type === 'memory.create' ? command.result?.memory : command?.type === 'mind.create' ? command.result?.mind : null;
    const name = command?.payload?.title ?? command?.payload?.name;
    if (command?.status === 'done' && value && typeof name === 'string' && name.startsWith(prefix)) {
      ownedIds.add(value.id);
      state.ids.push({ kind: command.type.startsWith('memory.') ? 'memory' : 'mind', id: value.id });
    }
  }
  async function read(name, args = {}) {
    const result = await transport(name, args);
    if (result.content) {
      const text = result.content.find(c => c.type === 'text')?.text;
      try { return { data: JSON.parse(text), isError: !!result.isError }; }
      catch { return { data: { error: text }, isError: true }; }
    }
    return result;
  }
  async function check(label, name, args, predicate) {
    const started = Date.now();
    const result = await read(name, args);
    if (result.data?.commandId) {
      // A negative mutation can regress into an accepted write: retain it for cleanup.
      state.commands.push({ id: result.data.commandId, label, name, args });
    }
    state.cases.push({ label, tool: name, status: predicate(result.data, result.isError) ? 'passed' : 'failed',
      observed: result, durationMs: Date.now() - started });
    await save(); return result.data;
  }
  async function write(label, name, args, expected = 'done') {
    const started = Date.now();
    if (args.id && !ownedIds.has(args.id)) throw new Error('Refusing to mutate an entity without matching creation evidence: ' + args.id);
    const result = await read(name, args);
    if (result.isError || !result.data.commandId) {
      state.cases.push({ label, tool: name, status: 'failed', expected, observed: result, durationMs: Date.now() - started });
      await save(); return null;
    }
    const id = result.data.commandId;
    state.commands.push({ id, label, name, args }); await save();
    let command;
    do {
      command = (await read('get_command_status', { id })).data.command;
      if (command && ['done', 'failed', 'conflict'].includes(command.status)) break;
      await sleep(5000);
    } while (Date.now() - started < 120000);
    state.cases.push({ label, tool: name, status: command?.status === expected ? 'terminal-matched' : 'failed',
      expected, observed: command, durationMs: Date.now() - started });
    rememberCreation(command);
    await save();
    if (!command || !['done', 'failed', 'conflict'].includes(command.status)) throw new Error(`Timed out: ${label}`);
    return command;
  }
  async function entity(label, id, predicate) { return check(label, 'get_memory', { id }, r => r.memory && predicate(r.memory)); }
  async function patch(label, id, value, predicate) {
    const c = await write(label, 'update_memory', { id, patch: value });
    if (c?.status === 'done') return (await entity(`${label}: mirror`, id, predicate)).memory;
    return null;
  }
  async function create(label, args, key) {
    const c = await write(label, 'create_memory', args);
    if (c?.result?.memory) {
      state[key] = c.result.memory.id; await save();
      await entity(`${label}: mirror`, state[key], m => m.title === args.title);
      return c.result.memory;
    }
    return null;
  }
  try {
    // Reconstruct ownership from server-side creation receipts, never from an arbitrary checkpoint ID.
    for (const entry of state.commands) {
      if (entry.name && !entry.name.startsWith('create_')) continue;
      const receipt = await read('get_command_status', { id: entry.id });
      if (!receipt.isError) rememberCreation(receipt.data.command);
    }
    for (const key of ['root', 'child', 'grandchild', 'minimal', 'complete']) {
      if (state[key] && !ownedIds.has(state[key])) throw new Error('Cannot verify setup ownership: ' + key);
    }
    await check('Clock and timezone', 'get_current_time', {}, r => !!r.nowUtc && !!r.timeZone);
    if (!state.root) {
      const root = await write('Mind root create', 'create_mind', { name: prefix + ' Root', colorHex: '#F97316', iconName: 'folder' });
      state.root = root?.result?.mind?.id; await save();
    }
    if (!state.child) {
      const child = await write('Mind child create', 'create_mind', { name: prefix + ' Child', parentId: state.root });
      state.child = child?.result?.mind?.id; await save();
    }
    if (!state.grandchild) {
      const child = await write('Mind grandchild create', 'create_mind', { name: prefix + ' Grandchild', parentId: state.child });
      state.grandchild = child?.result?.mind?.id; await save();
    }
    await check('Mind hierarchy', 'list_minds', {}, r => flatten(r.minds).find(m => m.id === state.grandchild)?.parentId === state.child);
    await write('Mind edit metadata', 'update_mind', { id: state.child, patch: { name: prefix + ' Child Edited', colorHex: '#22C55E', iconName: 'star', sortOrder: 7 } });
    await check('Mind edited fields reflected', 'list_minds', {}, r => { const m = flatten(r.minds).find(x => x.id === state.child); return m?.name === prefix + ' Child Edited' && m.color === '#22C55E' && m.icon === 'star'; });
    await write('Mind cycle rejected', 'update_mind', { id: state.root, patch: { parentId: state.grandchild } }, 'failed');
    await write('Mind detach', 'update_mind', { id: state.grandchild, patch: { parentId: null } });
    await check('Mind detached reflected', 'list_minds', {}, r => flatten(r.minds).find(x => x.id === state.grandchild)?.parentId === null);
    await write('Mind reparent', 'update_mind', { id: state.grandchild, patch: { parentId: state.child } });
    await check('Mind reparent reflected', 'list_minds', {}, r => flatten(r.minds).find(x => x.id === state.grandchild)?.parentId === state.child);
    if (!state.minimal) await create('Minimal Memory', { title: prefix + ' Minimal' }, 'minimal');
    await entity('Minimal defaults', state.minimal, m => m.status === 'active' && !m.isPinned && m.note === null && m.priority === null && m.mindId === null && m.schedule === null && m.location === null && m.checklist.length === 0 && m.links.length === 0);
    const fireDate = '2028-02-29T23:30:00-03:00';
    const schedule = { fireDate, timeZone: 'America/Sao_Paulo', isActive: false, isAllDay: true,
      recurrence: { frequency: 'weekly', interval: 2, weekdays: ['mon', 'fri'], occurrenceCount: 4 },
      focus: { enabled: false, workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, pomodorosUntilLongBreak: 4, autoContinue: false } };
    let m = await create('Complete Memory', { title: prefix + ' Complete café 🚀', note: prefix + ' Note Needle',
      mind: state.grandchild, priority: 2, isPinned: true, dueDate: fireDate,
      checklist: [{ title: prefix + ' Checklist Needle', detail: 'First detail' }, { title: 'Second item' }],
      autoCompleteOnChecklistCompletion: false, schedule,
      location: { name: 'Test location', latitude: -23.55, longitude: -46.63, radiusMeters: 200, event: 'onEntry', isActive: false },
      links: [{ url: 'https://example.com/reference', title: 'Reference' }] }, 'complete');
    if (!m) throw new Error('Complete Memory creation failed');
    await entity('Complete fields round trip', m.id, x => x.note === prefix + ' Note Needle' && x.priority === 2 && x.isPinned && x.mindId === state.grandchild &&
      x.checklist.length === 2 && x.dueDate === '2028-03-01T02:30:00.000Z' && x.schedule?.recurrence?.frequency === 'weekly' &&
      x.schedule?.recurrence?.interval === 2 && x.schedule?.recurrence?.occurrenceCount === 4 && x.schedule?.focus?.autoContinue === false &&
      x.location?.isActive === false && x.links[0]?.title === 'Reference');
    for (const query of [prefix.toLowerCase() + ' complete', prefix.toUpperCase() + ' NOTE NEEDLE', prefix.toLowerCase() + ' checklist needle'])
      await check('Search ' + query, 'list_memories', { query }, r => r.memories.some(x => x.id === m.id));
    await check('Combined inclusive filters', 'list_memories', { mind: state.grandchild, status: 'active', pinned: true, dueFrom: fireDate, dueTo: fireDate, query: prefix, limit: 1 }, r => r.memories.length === 1 && r.memories[0].id === m.id);
    await check('Mind case-insensitive name', 'list_memories', { mind: (prefix + ' Grandchild').toLowerCase() }, r => r.memories.some(x => x.id === m.id));
    await check('Empty query result', 'list_memories', { query: prefix + ' absent-value' }, r => r.memories.length === 0);
    const oldVersion = m.updatedAt;
    m = await patch('Update title preserving omitted fields', m.id, { title: prefix + ' Edited' }, x => x.note === prefix + ' Note Needle' && x.checklist.length === 2 && x.links.length === 1 && x.title.endsWith('Edited')) ?? m;
    await write('Stale version conflict', 'update_memory', { id: m.id, baseVersion: oldVersion, patch: { title: prefix + ' Must not apply' } }, 'conflict');
    await entity('Conflict preserves newer title', m.id, x => x.title === prefix + ' Edited');
    await write('Toggle checklist', 'toggle_check_item', { id: m.id, itemId: m.checklist[0].id });
    await entity('Toggle reflected', m.id, x => x.checklist.find(c => c.id === m.checklist[0].id)?.isCompleted === true);
    m = await patch('Checklist edit reorder replace', m.id, { checklist: [{ ...m.checklist[0], title: 'Renamed item', isCompleted: false, sortOrder: 3 }, { title: 'New item', sortOrder: 0 }] }, x =>
      x.checklist.length === 2 && x.checklist[0].title === 'New item' && x.checklist[1].id === m.checklist[0].id) ?? m;
    await write('Duplicate checklist ID rejected', 'update_memory', { id: m.id, patch: { checklist: [{ id: m.checklist[0].id, title: 'A' }, { id: m.checklist[0].id, title: 'B' }] } }, 'failed');
    await entity('Failed checklist edit is atomic', m.id, x => x.checklist.length === 2 && x.checklist[0].title === 'New item');
    await write('Complete occurrence A', 'set_memory_status', { id: m.id, status: 'completed', occurrenceDate: '2028-03-03T12:00:00-03:00' });
    await entity('Occurrence A completed independently', m.id, x => x.completedDates.length === 1 && x.status === 'active');
    await write('Complete occurrence B', 'set_memory_status', { id: m.id, status: 'completed', occurrenceDate: '2028-03-17T12:00:00-03:00' });
    await write('Reopen occurrence A', 'set_memory_status', { id: m.id, status: 'active', occurrenceDate: '2028-03-03T12:00:00-03:00' });
    await entity('Occurrence B remains completed', m.id, x => x.completedDates.length === 1 && x.completedDates[0].startsWith('2028-03-17'));
    await patch('Clear nullable fields and move Inbox', m.id, { note: null, mind: null, priority: null, dueDate: null, schedule: null, location: null, checklist: [], links: [], isPinned: false }, x =>
      x.note === null && x.mindId === null && x.priority === null && x.dueDate === null && x.schedule === null && x.location === null && x.checklist.length === 0 && x.links.length === 0 && !x.isPinned);
    await write('Complete whole Memory', 'set_memory_status', { id: m.id, status: 'completed' });
    await entity('Whole completion reflected', m.id, x => x.status === 'completed' && !!x.completedAt);
    await write('Reopen whole Memory', 'set_memory_status', { id: m.id, status: 'active' });
    await entity('Whole reactivation reflected', m.id, x => x.status === 'active' && x.completedAt === null);
    await patch('Move Memory back to grandchild', m.id, { mindId: state.grandchild }, x => x.mindId === state.grandchild);
    for (const frequency of ['minutely', 'hourly', 'daily', 'weekly', 'monthly', 'yearly']) {
      await patch('Recurrence ' + frequency, state.minimal, { schedule: { fireDate, timeZone: 'America/Sao_Paulo', isActive: false,
        recurrence: { frequency, interval: 2, endDate: '2029-03-01T00:00:00-03:00', ...(frequency === 'weekly' ? { weekdays: ['sun'] } : {}) } } }, x => x.schedule?.recurrence?.frequency === frequency);
    }
    await patch('Clear recurrence fixture', state.minimal, { schedule: null }, x => x.schedule === null);
    for (const enabled of [false, true]) {
      await patch('Auto-completion configure ' + enabled, state.minimal, { autoCompleteOnChecklistCompletion: enabled, checklist: [{ title: 'Only item' }] }, x => x.autoCompleteOnChecklistCompletion === enabled);
      const item = (await read('get_memory', { id: state.minimal })).data.memory.checklist[0];
      await write('Auto-completion toggle ' + enabled, 'toggle_check_item', { id: state.minimal, itemId: item.id });
      await entity('Auto-completion behavior ' + enabled, state.minimal, x => x.status === (enabled ? 'completed' : 'active'));
      await write('Reset completion ' + enabled, 'set_memory_status', { id: state.minimal, status: 'active' });
    }
    const absent = '00000000-0000-4000-8000-000000000001';
    for (const [name, args] of [
      ['create_memory', { title: prefix + ' Invalid', mind: prefix + ' Missing' }],
      ['create_mind', { name: prefix + ' Invalid', parentId: absent }],
      ['get_memory', { id: absent }], ['toggle_check_item', { id: m.id, itemId: absent }],
      ['create_memory', { title: '', schedule: null }],
      ['create_memory', { title: prefix + ' Invalid location', location: { latitude: 91, longitude: 0 } }],
      ['create_memory', { title: prefix + ' Invalid timezone', schedule: { fireDate, timeZone: 'Invalid/Zone' } }],
      ['create_memory', { title: prefix + ' Invalid recurrence', schedule: { fireDate, recurrence: { frequency: 'daily', occurrenceCount: 2, endDate: fireDate } } }],
    ]) await check('Reject invalid ' + name + ' ' + JSON.stringify(args), name, args, (_r, error) => error);
    const deletionTree = flatten((await read('list_minds')).data.minds);
    const rootNode = deletionTree.find(x => x.id === state.root);
    if (!rootNode || flatten([rootNode]).some(x => !ownedIds.has(x.id))) throw new Error('Mind tree contains unverified entities');
    await write('Delete Mind tree', 'delete_mind', { id: state.root, confirm: true });
    await check('Recursive Mind removal reflected', 'list_minds', {}, r => !flatten(r.minds).some(x => [state.root, state.child, state.grandchild].includes(x.id)));
    await entity('Deleted tree Memory moved Inbox', m.id, x => x.mindId === null);
  } catch (error) {
    state.cases.push({ label: 'Dependent scenarios', status: 'blocked', observed: String(error) }); await save();
  } finally {
    // Drain known pending commands before cleanup; never infer ownership from a broad search.
    for (const entry of state.commands) {
      let command;
      const deadline = Date.now() + 120000;
      do {
        const receipt = await read('get_command_status', { id: entry.id });
        if (receipt.isError || !receipt.data.command) {
          state.pendingCleanup = true;
          state.cases.push({ label: 'Cleanup command status unavailable ' + entry.id, status: 'blocked', observed: receipt });
          await save(); break;
        }
        command = receipt.data.command;
        if (!command || ['done', 'failed', 'conflict'].includes(command.status)) break;
        await sleep(5000);
      } while (Date.now() < deadline);
      if (command && !['done', 'failed', 'conflict'].includes(command.status)) {
        state.cases.push({ label: 'Cleanup unresolved command ' + entry.id, status: 'blocked', observed: command });
        state.pendingCleanup = true; await save();
      }
      rememberCreation(command);
    }
    const ids = [...new Map(state.ids.filter(x => ownedIds.has(x.id)).map(x => [x.id, x])).values()];
    for (const owned of ids.filter(x => x.kind === 'memory')) {
      const existing = await read('get_memory', { id: owned.id });
      if (existing.isError && !String(existing.data?.error).includes('not present in the mirror')) {
        state.pendingCleanup = true;
        state.cases.push({ label: 'Cleanup entity status unavailable ' + owned.id, status: 'blocked', observed: existing });
        await save(); continue;
      }
      if (!existing.isError) {
        await write('Cleanup Memory ' + owned.id, 'delete_memory', { id: owned.id, confirm: true });
        await check('Deleted Memory absent ' + owned.id, 'get_memory', { id: owned.id }, (_r, error) => error);
      }
    }
    for (const owned of ids.filter(x => x.kind === 'mind').reverse()) {
      const tree = flatten((await read('list_minds')).data.minds);
      const node = tree.find(x => x.id === owned.id);
      if (node && flatten([node]).some(x => !ownedIds.has(x.id))) {
        state.pendingCleanup = true; state.cases.push({ label: 'Cleanup Mind has unverified descendants ' + owned.id, status: 'blocked' });
        await save(); continue;
      }
      if (node) await write('Cleanup Mind ' + owned.id, 'delete_mind', { id: owned.id, confirm: true });
    }
    const memories = await read('list_memories', { query: prefix, limit: 1000 });
    const minds = await read('list_minds');
    state.cleanup = { status: !state.pendingCleanup && !memories.isError && !minds.isError && memories.data.memories.length === 0 && !flatten(minds.data.minds).some(x => ids.some(y => y.id === x.id)) ? 'passed' : 'failed',
      remainingMemories: memories.data.memories, remainingOwnedMinds: flatten(minds.data.minds).filter(x => ids.some(y => y.id === x.id)) };
    state.durationMs = Date.now() - start; await save();
  }
  return state;
}
