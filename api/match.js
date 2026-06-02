const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = req.body || {};
    const requestingTaskId = body.taskId;

    const { data: tasks, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('status', 'active')
      .not('agent_prompt', 'is', null);

    if (error) throw error;
    if (!tasks || tasks.length < 2) {
      return res.status(200).json({ message: 'Not enough active tasks to match', matched: 0 });
    }

    const buyers = tasks.filter(t => t.intent === 'looking');
    const sellers = tasks.filter(t => t.intent === 'offering');

    if (!buyers.length || !sellers.length) {
      return res.status(200).json({ message: 'Need both buyers and sellers', matched: 0 });
    }

    let buyersToMatch = buyers;
    let sellersToMatch = sellers;

    if (requestingTaskId) {
      const requestingTask = tasks.find(t => t.id === requestingTaskId);
      if (requestingTask?.intent === 'looking') {
        buyersToMatch = [requestingTask];
      } else if (requestingTask?.intent === 'offering') {
        sellersToMatch = [requestingTask];
      }
    }

    let matchCount = 0;

    for (const buyer of buyersToMatch) {
      for (const seller of sellersToMatch) {
        if (buyer.user_id === seller.user_id) continue;

        const { data: existing } = await supabase
          .from('matches')
          .select('id')
          .or(`and(task_a.eq.${buyer.id},task_b.eq.${seller.id}),and(task_a.eq.${seller.id},task_b.eq.${buyer.id})`)
          .single();

        if (existing) continue;

        const conversation = await runAgentConversation(buyer, seller);
        if (!conversation) continue;

        const matchResult = await scoreMatch(buyer, seller, conversation);
        if (!matchResult) continue;

        const scoreNum = parseInt(matchResult.score);
        if (scoreNum < 60) continue;

        await supabase.from('matches').insert({
          user_a: buyer.user_id,
          user_b: seller.user_id,
          task_a: buyer.id,
          task_b: seller.id,
          conversation,
          score: matchResult.score,
          summary: matchResult.summary,
          common_ground: matchResult.common
        });

        matchCount++;
      }
    }

    return res.status(200).json({ message: `Found ${matchCount} new match${matchCount !== 1 ? 'es' : ''}`, matched: matchCount });

  } catch (err) {
    console.error('Match engine error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function runAgentConversation(buyer, seller) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: `Two AI agents are qualifying whether a deal is possible.

BUYER is looking for: ${buyer.agent_prompt}
SELLER is offering: ${seller.agent_prompt}

First check if these are in the same category. If clearly mismatched (car buyer vs trading card seller), write one line saying so and stop.

If potentially a match, write a 4-5 exchange qualification conversation probing price, condition, location, timeline.

Format:
[BUYER]: text
[SELLER]: text`
        }]
      })
    });

    const data = await response.json();
    return data.content?.[0]?.text || null;
  } catch (e) {
    console.error('Conversation error:', e);
    return null;
  }
}

async function scoreMatch(buyer, seller, conversation) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Score this buyer-seller match. If different categories, score 0%.

Buyer: ${buyer.agent_prompt}
Seller: ${seller.agent_prompt}
Conversation: ${conversation}

Output ONLY this JSON:
{"score":"75%","summary":"Good alignment on price and location.","common":["Price range matches","Same location","Timeline works"]}`
        }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '{"score":"0%","summary":"No match","common":[]}';
    return JSON.parse(text.trim());
  } catch (e) {
    console.error('Score error:', e);
    return null;
  }
}

