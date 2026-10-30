#!/usr/bin/env node
import { main } from '../dist/native-terminal-cli.js';
main(process.argv.slice(2)).catch(() => { console.error('Pi terminal observer could not attach. Use --help and check the existing service. No agent was started.'); process.exitCode = 1; });
