// 文件：learn/demos/5-5-demo1-basic.ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

const message = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',  // 用 Haiku，最便宜
  max_tokens: 1024,
  messages: [
    {
      role: 'user',
      content: '用一句话解释什么是递归',
    }
  ],
})

console.log(message.content[0].text)