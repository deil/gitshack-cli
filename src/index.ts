#!/usr/bin/env node
import { createProgram, runCli } from './cli.js';
export { createProgram } from './cli.js';
await runCli(createProgram());
