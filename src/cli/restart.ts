import { manageService } from "./service.js";
export async function restart() { const result = await manageService("restart"); console.log(`Service restarted (${result.state}).`); }
