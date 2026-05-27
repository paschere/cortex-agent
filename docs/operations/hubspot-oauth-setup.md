# HubSpot OAuth setup

Create a HubSpot app (https://app.hubspot.com/developer/) with:
- Redirect URL: `${APP_BASE_URL}/api/integrations/hubspot/callback`
- Scopes: `crm.objects.companies.read`, `crm.objects.contacts.read`, `crm.objects.deals.read`, `crm.objects.owners.read`, `sales-email-read`

Set in Vercel env: `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REDIRECT_URI`.
