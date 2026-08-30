#!/usr/bin/env node
// Stdio entry point for the ultracode MCP server — the offline/compatibility
// transport. Tool registration lives in mcp/create-server.js so this surface
// cannot drift from the HTTP hub's (mcp/hub-server.js, mcp/hub-shim.js).
// Deliberately hub-unaware: no discovery file, no network, works standalone.

"use strict";

const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createUltracodeServer } = require("./create-server");

createUltracodeServer().connect(new StdioServerTransport());
