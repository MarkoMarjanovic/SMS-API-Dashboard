# Operator walkthrough

A guide for the team using the dashboard every day.

## Daily (2 minutes)

1. **Overview**: check the red/amber banners at the top. They are open alerts.
2. Look at the **budget card**: if the forecast is above budget, find out why (Countries → sort by spend, or Verify & fraud).
3. **Inbox**: answer real questions; STOP replies are handled automatically.

## Weekly

- **Countries**: a country with a falling delivery rate usually means a registration or carrier filtering problem. Open it to see the failure codes and advice.
- **Verify & fraud**: any country marked *High* or *Watch* that you don't serve should be blocked.
- **Alerts**: acknowledge what you've handled.

## Monthly

- **Reports**: pick last month, export CSV/PDF for finance, compare with the Telesign invoice.
- If the totals differ, check that traffic from other systems was imported (**Import usage**) and that the rate card matches the contract. Then use **Rate card → Re-price history**.
- Review **fixed fees** (number rental, 10DLC campaign fees, support plans).

## Sending a campaign

1. **Contacts → Import CSV**: map the phone column; set the default country for numbers without `+`; set consent (only mark *opted in* if you have records).
2. **Campaigns → New campaign**:
   - Keep the counter at **1 segment** where possible; the counter shows which characters force Unicode.
   - Marketing messages must include opt-out text ("Reply STOP to opt out").
   - Choose audience tag / countries; the preview shows recipients, exclusions, cost per country and budget impact.
3. **Test** to 2–3 internal phones. Check text, sender and delivery.
4. **Launch** (now or scheduled). Watch progress in the list; **Pause** at any time.
5. Afterwards open the campaign to see delivery, cost, replies and opt-out rate. A high opt-out rate (> 2%) means the audience or content needs work.

## Handling an alert

| Alert | What to do |
|---|---|
| Budget 80% | Check the forecast; postpone non-urgent campaigns or raise the budget deliberately. |
| Budget 100% (hard stop on) | Sends are being blocked (status 901). Raise the budget only if the spend is legitimate. |
| Spend spike in a country | Open the country. Was there a campaign? If not, treat it like fraud. |
| Possible SMS pumping | Block the country (Verify & fraud → Block) unless you have real users there. Tell the team that owns sign-up/login to add rate limiting and CAPTCHA. |
| First traffic to a new country | Confirm it's expected; otherwise block it. |

## Status codes in the message log

Codes 2xx/5xx come from Telesign (the log shows the meaning and advice). Codes **900–905** come from the dashboard itself:
900 opted out · 901 budget/cap reached · 902 country not allowed · 903 invalid number · 904 Telesign request failed · 905 quiet hours/rate limit.

## Roles

- **Admin**: send, change settings, manage users and tokens.
- **Viewer**: read-only access to everything (good for finance).
