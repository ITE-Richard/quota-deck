import { version } from '../package.json';

/** 由 esbuild 在打包時內嵌 package.json 的版本號，避免多處手動同步。 */
export const EXTENSION_VERSION: string = version;
