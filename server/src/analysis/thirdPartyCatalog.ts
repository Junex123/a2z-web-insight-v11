import type { ThirdPartyCategory } from "../types.js";

/**
 * A deliberately small, hand-maintained list of well-known third-party
 * domains. This is NOT an attempt at exhaustive vendor detection - it
 * exists so a handful of extremely common, unambiguous origins
 * (Google Analytics, Google Fonts, common tag managers, etc.) get a
 * useful label instead of being reported as a bare, unfamiliar domain.
 * Anything not on this list is categorized as `null` (uncategorized) -
 * never inferred from the domain's name or shape. Adding an entry here
 * should only happen for a domain whose purpose is genuinely
 * unambiguous and stable.
 */
const KNOWN_THIRD_PARTIES: { suffix: string; category: ThirdPartyCategory; label: string }[] = [
  { suffix: "google-analytics.com", category: "analytics", label: "Google Analytics" },
  { suffix: "analytics.google.com", category: "analytics", label: "Google Analytics" },
  { suffix: "googletagmanager.com", category: "tag-manager", label: "Google Tag Manager" },
  { suffix: "segment.io", category: "analytics", label: "Segment" },
  { suffix: "segment.com", category: "analytics", label: "Segment" },
  { suffix: "mixpanel.com", category: "analytics", label: "Mixpanel" },
  { suffix: "hotjar.com", category: "analytics", label: "Hotjar" },
  { suffix: "plausible.io", category: "analytics", label: "Plausible Analytics" },

  { suffix: "doubleclick.net", category: "advertising", label: "Google DoubleClick" },
  { suffix: "googlesyndication.com", category: "advertising", label: "Google AdSense" },
  { suffix: "googleadservices.com", category: "advertising", label: "Google Ads" },
  { suffix: "facebook.net", category: "advertising", label: "Meta Pixel / SDK" },
  { suffix: "adroll.com", category: "advertising", label: "AdRoll" },
  { suffix: "taboola.com", category: "advertising", label: "Taboola" },
  { suffix: "outbrain.com", category: "advertising", label: "Outbrain" },

  { suffix: "connect.facebook.net", category: "social", label: "Facebook SDK" },
  { suffix: "platform.twitter.com", category: "social", label: "Twitter/X widgets" },
  { suffix: "platform.linkedin.com", category: "social", label: "LinkedIn widgets" },
  { suffix: "assets.pinterest.com", category: "social", label: "Pinterest widgets" },

  { suffix: "fonts.googleapis.com", category: "fonts", label: "Google Fonts (stylesheet)" },
  { suffix: "fonts.gstatic.com", category: "fonts", label: "Google Fonts (files)" },
  { suffix: "use.typekit.net", category: "fonts", label: "Adobe Fonts (Typekit)" },
  { suffix: "fonts.adobe.com", category: "fonts", label: "Adobe Fonts" },

  { suffix: "cdnjs.cloudflare.com", category: "cdn", label: "cdnjs" },
  { suffix: "cdn.jsdelivr.net", category: "cdn", label: "jsDelivr" },
  { suffix: "unpkg.com", category: "cdn", label: "unpkg" },
  { suffix: "ajax.googleapis.com", category: "cdn", label: "Google Hosted Libraries" },

  { suffix: "intercom.io", category: "chat", label: "Intercom" },
  { suffix: "widget.intercom.io", category: "chat", label: "Intercom" },
  { suffix: "crisp.chat", category: "chat", label: "Crisp" },
  { suffix: "tawk.to", category: "chat", label: "Tawk.to" },
  { suffix: "zdassets.com", category: "chat", label: "Zendesk" },

  { suffix: "youtube.com", category: "video", label: "YouTube" },
  { suffix: "ytimg.com", category: "video", label: "YouTube" },
  { suffix: "player.vimeo.com", category: "video", label: "Vimeo" },
  { suffix: "wistia.com", category: "video", label: "Wistia" },

  { suffix: "js.stripe.com", category: "payment", label: "Stripe" },
  { suffix: "paypal.com", category: "payment", label: "PayPal" },
  { suffix: "paypalobjects.com", category: "payment", label: "PayPal" },

  { suffix: "sentry.io", category: "monitoring", label: "Sentry" },
  { suffix: "newrelic.com", category: "monitoring", label: "New Relic" },
  { suffix: "nr-data.net", category: "monitoring", label: "New Relic" },
  { suffix: "datadoghq-browser-agent.com", category: "monitoring", label: "Datadog RUM" },
];

/** Returns category+label only for an exact or subdomain match against the curated list above; null otherwise - never guessed. */
export function categorizeThirdPartyOrigin(origin: string): { category: ThirdPartyCategory; label: string } | null {
  const normalized = origin.toLowerCase();
  for (const entry of KNOWN_THIRD_PARTIES) {
    if (normalized === entry.suffix || normalized.endsWith(`.${entry.suffix}`)) {
      return { category: entry.category, label: entry.label };
    }
  }
  return null;
}
