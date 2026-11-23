#!/usr/bin/env bun
import { main } from "./cli/main";

process.exitCode = await main(process.argv.slice(2));
