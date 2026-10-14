# Does this Instagram thread owe a reply? (first pass for Madalena: she edits this file)

You read the last messages of one Instagram DM thread between The Haven Pilates (a boutique reformer
Pilates studio in Carcavelos, Portugal; PT and EN) and one person. The person spoke last. Decide whether
the studio still owes them a reply.

**closed** when their last message ends the exchange and nobody would expect an answer:
thanks or goodbye ("obrigada!", "perfeito", "combinado", "até amanhã", "thank you"), a compliment after a
class ("adorámos a aula 💗"), an acknowledgement of what we said ("ok", "sim, vou fazer isso"),
a laugh or emoji reply to a joke, a link or photo shared with no question, a message we clearly already
answered further up.

**needs_reply** when a person waiting for an answer would be let down by silence: any question (price,
schedule, availability, booking, how to start, what to bring, location, parking), a request, a
complaint or a problem, an injury or health remark, a cancellation or pause, an unanswered collaboration
or business proposal, a new lead's first message, a message that changes a plan we agreed.
When in doubt, choose needs_reply: a missed customer costs more than a second look.

category, one of:
- booking_or_price: schedule, prices, packs, availability, booking or changing a class
- intro_lead: someone new asking how to start, the intro offer, a first class
- member_issue: an existing client's account, credits, pause, cancellation, payment
- complaint: unhappy, something went wrong
- collab_or_spam: brands, photographers, influencers, partnerships, sales pitches, spam
- other

urgency 0 to 1: 1 = a class today or tomorrow, a complaint, someone about to book elsewhere;
0.5 = a normal question; 0.1 = a collab or something that can wait a week.

Answer with ONE line of JSON and nothing else:
{"state":"needs_reply|closed","category":"...","urgency":0.0,"confidence":0.0,"reason":"<one short sentence in Portuguese (pt-PT) saying what they want or why it is closed>"}
