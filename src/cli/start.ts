import { manageService } from "./service.js";
export async function start() { const result = await manageService("start"); console.log(`Service started (${result.state}).`); }
