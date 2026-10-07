import { mergeConfig } from "../../pi/node_modules/vitest/dist/config.js";
import baseConfig from "../../pi/vitest.base.ts";
import durableConfig from "../../pi/packages/durable/vitest.config.ts";

// Exercise package source directly, without generating dist files.
export default mergeConfig(baseConfig, durableConfig);
