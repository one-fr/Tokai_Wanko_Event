import Anthropic from '@anthropic-ai/sdk';

/**
 * 用途ごとにモデルを分ける。
 * - extract: 検索結果から「東海3県の犬メインイベントか」を判断する必要があり精度が要る
 * - estimate: 参考実績をもとに幅を出すだけの単純タスクなので安価なモデルで足りる
 */
export const MODELS = {
  extract: 'claude-sonnet-5',
  estimate: 'claude-haiku-4-5',
};

export const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// サーバー側ツール（web_search）のループ上限に達した場合の再開回数
const MAX_TURNS = 8;

/**
 * Web検索ツール定義。
 *
 * Anthropicのサーバー側で実行されるため、クライアント側で検索処理を書く必要はない。
 * max_uses で1リクエストあたりの検索回数を制限する（$10 / 1,000検索）。
 *
 * ※ 2026-01-20付でGoogle Programmable Search Engineの「ウェブ全体を検索」が
 *    新規エンジンで利用不可になったため、Custom Search APIから移行した経路。
 */
export function webSearchTool({ maxUses = 8 } = {}) {
  return {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: maxUses,
    user_location: { type: 'approximate', country: 'JP', timezone: 'Asia/Tokyo' },
  };
}

/**
 * Claude APIから構造化データを取得するヘルパー。
 *
 * serverTools を渡さない場合は tool_choice で対象ツールを強制し、1往復で結果を得る。
 * serverTools（web_search等）を渡す場合は、先に検索させる必要があるため強制できない。
 * この場合は tool_choice: auto とし、対象ツールが呼ばれるまでターンを進める。
 *
 * thinking / effort は渡されたときだけリクエストに載せる。Haiku 4.5 は
 * output_config.effort を受け付けずエラーになるため、常時付与してはいけない。
 *
 * @param {object} params
 * @param {string} params.model - 使用するモデルID（MODELSから選ぶ）
 * @param {string} params.system - システムプロンプト
 * @param {string} params.userContent - ユーザーメッセージ本文
 * @param {object} params.tool - 構造化データを受け取るツール定義
 * @param {number} [params.maxTokens=4096] - 思考トークンと出力トークンの合計上限
 * @param {object} [params.thinking] - 例: { type: 'adaptive' }
 * @param {string} [params.effort] - low | medium | high | xhigh | max
 * @param {object[]} [params.serverTools] - web_search等のサーバー側ツール
 * @returns {Promise<object>} tool_useブロックのinput（構造化データ）
 */
export async function runStructured({
  model,
  system,
  userContent,
  tool,
  maxTokens = 4096,
  thinking,
  effort,
  serverTools = [],
}) {
  const useServerTools = serverTools.length > 0;
  // max_uses を指定しても実際の検索回数がそれを超えることが観測されている
  // （web_search_20260209 は動的フィルタリングのため内部でコード実行を伴う）。
  // ターンをまたぐ累計でも上限を効かせるため、残数を都度計算して渡し、
  // 使い切ったら tool_choice で記録ツールを強制して打ち切る。
  const searchBudget =
    serverTools.find((t) => t.name === 'web_search')?.max_uses ?? Number.POSITIVE_INFINITY;

  const messages = [{ role: 'user', content: userContent }];
  let searchCount = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const budgetLeft = searchBudget - searchCount;

    // 予算を使い切ったらツール定義は残したまま（履歴の整合性のため）記録ツールを強制し、
    // それ以上検索させずに手持ちの情報で確定させる
    const exhausted = useServerTools && budgetLeft <= 0;
    const tools = useServerTools
      ? [
          ...serverTools.map((t) =>
            t.name === 'web_search' ? { ...t, max_uses: Math.max(1, budgetLeft) } : t
          ),
          tool,
        ]
      : [tool];
    const toolChoice =
      useServerTools && !exhausted ? { type: 'auto' } : { type: 'tool', name: tool.name };

    if (exhausted && turn > 0) {
      console.log(`[web_search] 上限${searchBudget}回に到達。検索を打ち切って記録します`);
    }

    const body = { model, max_tokens: maxTokens, system, messages, tools, tool_choice: toolChoice };
    if (thinking) body.thinking = thinking;
    if (effort) body.output_config = { effort };

    // SDKは max_tokens から所要時間を見積もり、10分を超えうる非ストリーミング要求を拒否する
    // （閾値は 128000 * 10 / 60 ≒ 21,333 トークン）。抽出は32000を使うためこれに掛かる。
    // ストリーミングで受け取り、finalMessage() で通常のMessageと同じ形に組み立てる。
    const message = await client.messages.stream(body).finalMessage();

    const searchesThisTurn = message.content.filter(
      (b) => b.type === 'server_tool_use' && b.name === 'web_search'
    ).length;
    searchCount += searchesThisTurn;

    if (useServerTools) {
      const requested = exhausted ? '強制記録' : `max_uses=${Math.max(1, budgetLeft)}`;
      console.log(
        `[web_search] turn${turn}: 検索${searchesThisTurn}回（累計${searchCount}） / 要求=${requested} / stop_reason=${message.stop_reason}`
      );
      if (searchesThisTurn > Math.max(1, budgetLeft)) {
        console.warn(
          `[web_search] 警告: このターンの検索回数がmax_usesの指定を超えました（指定${Math.max(1, budgetLeft)} → 実際${searchesThisTurn}）`
        );
      }
    }

    if (message.stop_reason === 'refusal') {
      throw new Error(
        `Claude APIがリクエストを拒否しました（category=${message.stop_details?.category ?? '不明'}）`
      );
    }
    if (message.stop_reason === 'max_tokens') {
      throw new Error(
        `Claude APIの出力がmax_tokens(${maxTokens})に達して打ち切られました（model=${model}）。max_tokensを増やしてください`
      );
    }

    const toolUse = message.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (toolUse) {
      if (useServerTools) console.log(`[web_search] 検索実行: 合計${searchCount}回`);
      return toolUse.input;
    }

    // サーバー側ツールのループ上限。内容をそのまま返して再開させる
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }

    // 検索だけして記録ツールを呼ばずに終わった場合は促す
    if (message.stop_reason === 'end_turn') {
      messages.push({ role: 'assistant', content: message.content });
      messages.push({
        role: 'user',
        content: `${tool.name} ツールを呼び出して結果を記録してください。該当が1件も無い場合は空配列で記録してください。`,
      });
      continue;
    }

    throw new Error(
      `想定外の stop_reason です（model=${model}, stop_reason=${message.stop_reason}）`
    );
  }

  throw new Error(`${MAX_TURNS}ターン以内に ${tool.name} が呼び出されませんでした（model=${model}）`);
}
