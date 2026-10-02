import pkg from "../../package.json";

declare const BUILD_VERSION: string | undefined;
export const version = typeof BUILD_VERSION !== "undefined" ? BUILD_VERSION : pkg.version || "dev";
