import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('*')
      .not('bio', 'is', null)
      .not('handle', 'is', null);

    if (error) throw error;
    if (!profiles || profiles.length < 2) {
      return res.status(200).json({ message: 'Not enough users to match yet', matched: 0 });
    }

    const buyers = profiles.filter(p => p.values?.includes('looking'));
    const sellers = profiles.filter(p => p.values?.includes('offering'));

    if (!buyers.length || !sellers.length) {
      return res.status(200).json({ message: 'Need both buyers and sellers', matched: 0 });
    }

    let matchCount = 0;

    for (const buyer of buyers) {
      for (const seller of sellers) {
        if (buyer.id === seller.id) continue;

        const { data: existing } = await supabase
          .from('matches')
          .select('id')
          .or(`and(user_a.eq.${buyer.id},user_b.eq.${seller.id}),and(user_a.eq.${seller.id},user_b.eq.${buyer.id})`)
          .single();

        if (existing) continue;

        const conversation = await runAgentConversation(buyer, seller);
        if (!conversation) continue;

        const matchResult = await scoreMatch(buyer, seller, conversation);
        if (!matchResult) continue;

        const scoreNum = parseInt(matchResult.score);
        if (scoreNum < 60) continue;

        await supabase.from('matches').insert({
          user_a: buyer.id,
          user_b: seller.id,
          conversation: conversation,
          score: matchResult.score,
          summary: matchResult.summary,
          common_ground: matchResult.common
        });

        matchCount++;
      }
    }

    return res.status(200).json({ message: `Matched ${matchCount} pairs`, matched: matchCount });

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
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `You are simulating a conversation between two AI agents in a marketplace. One represents a buyer, one a seller. They are qualifying whether there is a deal to be made.

Buyer agent (representing ${buyer.display_name || buyer.handle}):
${buyer.bio}

Seller agent (representing ${seller.display_name || seller.handle}):
${seller.bio}

Write a 4-5 exchange conversation where the agents probe for fit — price, timeline, location, requirements. Be realistic and specific. If the deal obviously doesn't work, show the agents figuring that out quickly.

Format each line as:
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
          content: `Based on this agent conversation between a buyer and seller, score the match and summarize.

Buyer: ${buyer.bio}
Seller: ${seller.bio}
Conversation: ${conversation}

Output ONLY this JSON, nothing else:
{"score":"75%","summary":"Good alignment on price and location.","common":["Price range matches","Same location","Timeline works"]}`
        }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    return JSON.parse(text.trim());
  } catch (e) {
    console.error('Score error:', e);
    return null;
  }
}
