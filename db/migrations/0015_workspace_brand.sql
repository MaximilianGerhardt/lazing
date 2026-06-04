-- 0015: business brand per workspace (user clarification 2026-04-25):
-- The branding tab is NOT the token stack of the lazyOS app, but the brand
-- of the customer / project in that workspace. Logo, brand colors,
-- brand voice, email signature land here — things that should appear in
-- outbound communication, PDFs, Stripe receipts.
--
-- brand_colors: JSON array with up to 3 HEX colors ["#0A2540","#FF6B35","#F5F5F7"]
-- brand_voice: markdown — tonality, dos/don'ts, reference phrases
-- email_signature: markdown — appended below outbound mails

ALTER TABLE workspaces ADD COLUMN logo_url TEXT;
ALTER TABLE workspaces ADD COLUMN wordmark_url TEXT;
ALTER TABLE workspaces ADD COLUMN brand_colors TEXT;
ALTER TABLE workspaces ADD COLUMN brand_voice TEXT;
ALTER TABLE workspaces ADD COLUMN email_signature TEXT;
ALTER TABLE workspaces ADD COLUMN canonical_domain TEXT;
