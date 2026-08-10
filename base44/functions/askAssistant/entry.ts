import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// The model occasionally appends an unsolicited pricing "Pro-Tip" quoting a $49
// Pro Plan that does not exist. Drop any sentence/line that states a price or
// plan name other than the verified $99 Precision price.
const BAD_PRICING = /(\$(?!99\b)\d+)|pro plan|unlimited (team|member|rep|seat|user)|(no|without) (extra|additional) (per-user |per user )?(cost|fee)/i;

function stripIncorrectPricing(answer) {
    const text = String(answer || '');
    const kept = text
        .split('\n')
        .map((line) => line
            .split(/(?<=[.!?])\s+/)
            .filter((sentence) => !BAD_PRICING.test(sentence))
            .join(' ')
            .trim())
        .filter((line, index, lines) => line || (index > 0 && lines[index - 1]));
    return kept.join('\n').trim();
}

export default async function(req) {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const { question } = await req.json();
        const cleanQuestion = String(question || '').trim();
        if (!cleanQuestion) {
            return Response.json({ error: 'Question is required' }, { status: 400 });
        }

        const precisionQuestion = /precision|build mode|area pull|zip code|pricing tier|free plan|pro plan/i.test(cleanQuestion);
        if (precisionQuestion) {
            return Response.json({
                answer: 'Precision Generation is part of the Build Mode routing engine and is included in both plans. The Free Plan includes unlimited ZIP codes and up to 50 homes on the initial generation. Paid Precision is $99 per user per month and provides up to 1,000 homes per monthly billing period after payment clears.'
            });
        }

        const teamQuestion = /team member|teammate|add (a )?(rep|user|member)|invite|seat|roster|team section|team management/i.test(cleanQuestion);
        if (teamQuestion) {
            return Response.json({
                answer: 'Team members are not unlimited or free. Each rep needs a paid seat on your subscription, billed per user per month, and an invite code only works after that seat is paid for.\n\n1. Open the Team page.\n2. Add the seat to your subscription in Plans.\n3. Create an invite code and send it to the rep.\n4. Once they redeem it, assign them routes from the Command Center.'
            });
        }

        const assistantPrompt = `
You are the in-app support assistant for FirstKnock, a door-to-door route and territory platform.

RESPONSE STYLE:
- Start with the answer. Do not use a preamble, greeting, or restate the question.
- Default to 1-3 short sentences and no more than 70 words.
- Use plain text for simple answers. Use a short list only when presenting 3 or more distinct items.
- Do not add decorative bold text, headings, background explanations, or a tutorial unless the user asks for steps.
- If steps are requested, give at most 4 short numbered steps.
- Ask one brief clarifying question only when the request cannot be answered safely from the information below. Never end a complete answer with a follow-up question.
- Never invent features, prices, limits, algorithms, or navigation labels.

CURRENT FIRSTKNOCK FACTS (AUTHORITATIVE):
- The official product name is Precision Mode. Precision Generation is its targeted property-generation flow.
- Precision Generation is part of the Build Mode routing engine. It finds targeted single-family properties inside a manager-drawn area and turns the qualifying results into route homes.
- Both plans include routing features and unlimited ZIP codes.
- Paid Precision Generation provides up to 1,000 Precision homes per user in each monthly billing period. It costs $99 per user per month and unlocks only after payment clears and paid access is confirmed.
- Before paid Precision access, the Free Plan can receive up to 50 homes on the initial Precision generation.
- Adding a card or starting a trial does not unlock the paid 1,000-home monthly allowance.
- Knock decisions are separate from Precision homes. A free account must have a valid card on file after 25 logged decisions and reaches its free decision limit at 50 unless it upgrades.
- The Command Center map supports analyzing territory and building routes. Precision Mode must never be renamed Build Mode.
- Routes can be saved, assigned to reps, optimized using real road-travel data, and worked from the Knock checklist.
- Managers can invite reps, assign routes, and review team activity and outcomes.
- Team size is NOT unlimited and reps are NOT free. Each team member requires a paid seat on the manager's subscription, billed per user per month. An invite code only works once a seat has been paid for.
- Common outcomes include Sold, Qualified, Hard No, Callback, No Answer, Not Moved In, and Decision Maker Not Home.

PRECISION ANSWER RULES:
- For "What is Precision Generation?", explain that it generates targeted single-family route homes from a manager-drawn area and state the paid allowance: up to 1,000 homes per user per monthly billing period after the $99 payment clears.
- For questions about what is available before paying, state that the Free Plan includes unlimited ZIP codes and up to 50 homes on the initial Precision generation.
- Never claim FirstKnock uses K-Means clustering or genetic algorithms.
- Never claim either plan limits ZIP codes or includes 3 area pulls, 20 area pulls, or any other area-pull allowance not listed here.
- Never quote a $49 plan or call paid Precision the Pro Plan. The current paid Precision price is $99 per user per month.
- Never say team members, seats, reps, or users are unlimited, free, or included at no extra cost. Seats are paid per user per month.
- Never append a promotional "Pro-Tip", upsell, or pricing aside to an answer that was not about pricing.
- Answer ONLY from the authoritative facts above. If a detail is not stated there, say you are not certain and point the user to the relevant screen or FirstKnock support. Never fill a gap with a plausible guess.

USER QUESTION:
${JSON.stringify(cleanQuestion)}
`;

        const answer = await base44.integrations.Core.InvokeLLM({
            prompt: assistantPrompt,
            add_context_from_internet: false
        });

        return Response.json({ answer: stripIncorrectPricing(answer) });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
}