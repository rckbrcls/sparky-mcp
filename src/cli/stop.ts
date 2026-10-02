import { manageService } from "./service.js";
export async function stop() { const result = await manageService("stop"); console.log(`Service stopped (${result.state}).`); }
