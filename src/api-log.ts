export interface ApiFailureIssue {
  path?: readonly unknown[];
  message?: unknown;
}

export interface ApiFailureBody {
  error?: unknown;
  issues?: readonly ApiFailureIssue[];
}

function issueText(issue: ApiFailureIssue): string | null {
  if (typeof issue.message !== "string") return null;
  const message = issue.message.trim();
  if (!message) return null;
  const path = (issue.path ?? []).flatMap((part) =>
    typeof part === "string" && part.trim() ? [part.trim()] : typeof part === "number" && Number.isSafeInteger(part) ? [String(part)] : [],
  ).join(".");
  return path ? `${path}: ${message}` : message;
}

/** One stderr line for an API rejection. Includes issue paths and messages, never the request body. */
export function formatApiFailure(method: string, path: string, status: number, body: ApiFailureBody): string {
  const error = typeof body.error === "string" && body.error.trim() ? body.error.trim() : "Request failed.";
  const issues = (body.issues ?? []).slice(0, 3).flatMap((issue) => {
    const text = issueText(issue);
    return text ? [text] : [];
  });
  const detail = issues.length ? `${error} ${issues.join(" ")}` : error;
  return `api ${method} ${path} ${status} ${detail}`;
}
