import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-5';

export const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Claude APIに1つのツールを強制的に呼び出させ、構造化データを取得するヘルパー。
 * 抽出・予測のどちらも「JSON以外を返させない」ためにtool_choiceで固定する。
 *
 * @param {object} params
 * @param {string} params.system - システムプロンプト
 * @param {string} params.userContent - ユーザーメッセージ本文
 * @param {object} params.tool - Anthropic tools[] に渡す1件のツール定義
 * @param {number} [params.maxTokens=4096]
 * @returns {Promise<object>} tool_useブロックのinput（構造化データ）
 */
export async function runStructured({ system, userContent, tool, maxTokens = 4096 }) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userContent }],
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  });

  const toolUse = message.content.find((block) => block.type === 'tool_use');
  if (!toolUse) {
    throw new Error('Claude APIからtool_useブロックが返されませんでした');
  }
  return toolUse.input;
}
