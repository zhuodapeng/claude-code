import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';

const transport = new StdioClientTransport({
  command: 'claude',
  args: ['mcp', 'serve'],
});

const client = new Client({ name: 'mcp-check', version: '1.0.0' });

try {
  await client.connect(transport);

  const result = await client.request(
    { method: 'tools/list' },
    ListToolsResultSchema,
  );

  const tools = result.tools ?? [];
  console.log(`OK: ${tools.length} tools`);
  for (const tool of tools) {
    console.log(tool.name);
  }

  const targetFile = path.resolve(process.cwd(), 'scripts', `hello-word-${Date.now()}.txt`);
  const writeResult = await client.request(
    {
      method: 'tools/call',
      params: {
        name: 'Write',
        arguments: {
          file_path: targetFile,
          content: 'hello word',
        },
      },
    },
    CallToolResultSchema,
  );

  console.log(`Created file: ${targetFile}`);
  const firstContent = writeResult.content?.[0];
  if (firstContent && firstContent.type === 'text') {
    console.log(firstContent.text);
  }
} finally {
  await client.close();
}