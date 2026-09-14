import type { TechnologyCategoryId, TechnologyMetadata } from '../types.js';
import type { DetectionRule } from '../technologyRegistry.js';

export interface ExtendedTechnology {
  slug: string;
  name: string;
  category: TechnologyCategoryId;
  icon: string;
  homepage: string;
  rules: DetectionRule[];
  implies?: string[];
  requires?: string[];
  excludes?: string[];
  requiresCategory?: TechnologyCategoryId[];
  metadata?: TechnologyMetadata;
}

const hdr = (
  header: string, source: string, pattern: RegExp,
  confidence: DetectionRule['confidence'] = 'high',
): DetectionRule => ({ type: 'response-header', header, source, pattern, confidence });

const host = (
  source: string, pattern: RegExp,
  confidence: DetectionRule['confidence'] = 'high',
): DetectionRule => ({ type: 'request-host', source, pattern, confidence });

const script = (
  source: string, pattern: RegExp,
  confidence: DetectionRule['confidence'] = 'high',
  versionGroup?: number,
): DetectionRule => ({ type: 'script-url', source, pattern, confidence, versionGroup });

export const EXTENDED_TECHNOLOGIES: readonly ExtendedTechnology[] = [
  /* ───────────── Ecommerce ───────────── */
  {
    slug: 'magento', name: 'Adobe Commerce (Magento)', category: 'ecommerce',
    icon: 'magento', homepage: 'https://business.adobe.com/products/magento/magento-commerce.html',
    excludes: ['shopify', 'wix', 'squarespace'],
    rules: [
      { type: 'cookie-name', source: 'Magento form key cookie', pattern: /^(?:form_key|mage-cache-storage)$/, confidence: 'high' },
      { type: 'resource-url', source: '/static/version.../frontend/ path', pattern: /\/static\/version\d+\/frontend\//i, confidence: 'high' },
      { type: 'js-property', source: 'Magento require config', pattern: /^require\.s\.contexts\._\.config\.paths\.mage$/, confidence: 'medium' },
    ],
    metadata: { description: 'Enterprise ecommerce platform.', vendor: 'Adobe', openSource: true },
  },
  {
    slug: 'bigcommerce', name: 'BigCommerce', category: 'ecommerce',
    icon: 'bigcommerce', homepage: 'https://www.bigcommerce.com/',
    excludes: ['shopify', 'magento'],
    rules: [
      host('BigCommerce CDN host', /^cdn\d*\.bigcommerce\.com$/i),
      { type: 'inline-script', source: 'BigCommerce stencil bootstrap', pattern: /window\.stencilBootstrap/, confidence: 'high' },
    ],
    metadata: { description: 'Hosted ecommerce platform.', saas: true },
  },
  {
    slug: 'prestashop', name: 'PrestaShop', category: 'ecommerce',
    icon: 'prestashop', homepage: 'https://www.prestashop.com/',
    rules: [
      { type: 'meta-generator', source: '<meta name="generator">', pattern: /^PrestaShop/i, confidence: 'high' },
      { type: 'cookie-name', source: 'PrestaShop session cookie', pattern: /^PrestaShop-[a-f0-9]+$/i, confidence: 'high' },
    ],
    metadata: { description: 'Open-source ecommerce platform.', openSource: true },
  },

  /* ───────────── Frameworks ───────────── */
  {
    slug: 'astro', name: 'Astro', category: 'framework',
    icon: 'astro', homepage: 'https://astro.build/',
    rules: [
      { type: 'meta-generator', source: '<meta name="generator">', pattern: /^Astro\s+v?([\d.]+)?/i, versionGroup: 1, confidence: 'high' },
      { type: 'dom-selector', source: 'astro-island hydration element', pattern: /^astro-island$/, confidence: 'high' },
    ],
    metadata: { description: 'Content-focused web framework.', openSource: true },
  },
  {
    slug: 'remix', name: 'Remix / React Router', category: 'framework',
    icon: 'remix', homepage: 'https://remix.run/',
    implies: ['react'],
    rules: [
      { type: 'js-property', source: 'window.__remixContext', pattern: /^__remixContext$/, confidence: 'high' },
      { type: 'html-marker', source: 'Remix context script', pattern: /window\.__remixContext\s*=/, confidence: 'high' },
    ],
    metadata: { description: 'Full-stack React framework.', openSource: true, ecosystem: 'react' },
  },
  {
    slug: 'gatsby', name: 'Gatsby', category: 'framework',
    icon: 'gatsby', homepage: 'https://www.gatsbyjs.com/',
    implies: ['react'],
    rules: [
      { type: 'meta-generator', source: '<meta name="generator">', pattern: /^Gatsby\s*([\d.]+)?/i, versionGroup: 1, confidence: 'high' },
      { type: 'dom-selector', source: '#___gatsby mount point', pattern: /^#___gatsby$/, confidence: 'high' },
    ],
    metadata: { description: 'React static site generator.', openSource: true, ecosystem: 'react' },
  },
  {
    slug: 'alpinejs', name: 'Alpine.js', category: 'framework',
    icon: 'alpinedotjs', homepage: 'https://alpinejs.dev/',
    rules: [
      { type: 'js-property', source: 'window.Alpine.version', pattern: /^Alpine\.version$/, confidence: 'high', versionFromProperty: true },
      script('Alpine.js CDN bundle', /\/alpinejs@(\d+\.\d+\.\d+)/i, 'high', 1),
    ],
    metadata: { description: 'Lightweight declarative JS framework.', openSource: true },
  },
  {
    slug: 'htmx', name: 'htmx', category: 'framework',
    icon: 'htmx', homepage: 'https://htmx.org/',
    rules: [
      script('htmx CDN bundle', /\/htmx(?:\.org)?@?(\d+\.\d+\.\d+)?[^/]*\/?dist\/htmx/i, 'high', 1),
      { type: 'js-property', source: 'window.htmx.version', pattern: /^htmx\.version$/, confidence: 'high', versionFromProperty: true },
    ],
    metadata: { description: 'HTML-over-the-wire interactivity library.', openSource: true },
  },
  {
    slug: 'laravel', name: 'Laravel', category: 'framework',
    icon: 'laravel', homepage: 'https://laravel.com/',
    rules: [
      { type: 'cookie-name', source: 'Laravel session cookie', pattern: /^laravel_session$/, confidence: 'high' },
      { type: 'cookie-name', source: 'Laravel CSRF cookie', pattern: /^XSRF-TOKEN$/, confidence: 'medium' },
    ],
    metadata: { description: 'PHP web application framework.', openSource: true },
  },
  {
    slug: 'rails', name: 'Ruby on Rails', category: 'framework',
    icon: 'rubyonrails', homepage: 'https://rubyonrails.org/',
    rules: [
      hdr('x-runtime', 'x-runtime header (Rails timing)', /^[\d.]+$/, 'medium'),
      { type: 'dom-selector', source: 'csrf-param meta element', pattern: /^meta\[name="csrf-param"\]$/, confidence: 'medium' },
    ],
    metadata: { description: 'Ruby web application framework.', openSource: true },
  },

  /* ───────────── Analytics & experimentation ───────────── */
  {
    slug: 'segment', name: 'Segment', category: 'analytics',
    icon: 'segment', homepage: 'https://segment.com/',
    rules: [
      host('Segment CDN host', /^cdn\.segment\.(?:com|io)$/i),
      script('Segment analytics.js', /cdn\.segment\.(?:com|io)\/analytics\.js/i),
    ],
    metadata: { description: 'Customer data platform.', saas: true },
  },
  {
    slug: 'mixpanel', name: 'Mixpanel', category: 'analytics',
    icon: 'mixpanel', homepage: 'https://mixpanel.com/',
    rules: [
      host('Mixpanel CDN host', /^cdn\d?\.mxpnl\.com$/i),
      { type: 'xhr-host', source: 'Mixpanel ingest endpoint', pattern: /^api(?:-js)?\.mixpanel\.com$/i, confidence: 'high' },
    ],
    metadata: { description: 'Product analytics platform.', saas: true },
  },
  {
    slug: 'amplitude', name: 'Amplitude', category: 'analytics',
    icon: 'amplitude', homepage: 'https://amplitude.com/',
    rules: [
      host('Amplitude CDN host', /^cdn\.amplitude\.com$/i),
      { type: 'xhr-host', source: 'Amplitude ingest endpoint', pattern: /^api\d*\.amplitude\.com$/i, confidence: 'high' },
    ],
    metadata: { description: 'Product analytics platform.', saas: true },
  },
  {
    slug: 'plausible', name: 'Plausible Analytics', category: 'analytics',
    icon: 'plausibleanalytics', homepage: 'https://plausible.io/',
    rules: [script('Plausible tracker script', /plausible\.io\/js\/(?:script|plausible)[\w.]*\.js/i)],
    metadata: { description: 'Privacy-focused analytics.', openSource: true, saas: true },
  },
  {
    slug: 'matomo', name: 'Matomo', category: 'analytics',
    icon: 'matomo', homepage: 'https://matomo.org/',
    rules: [
      script('Matomo tracker script', /\/(?:matomo|piwik)\.js(?:\?|$)/i),
      { type: 'inline-script', source: 'Matomo _paq tracker queue', pattern: /var\s+_paq\s*=/, confidence: 'medium' },
    ],
    metadata: { description: 'Self-hostable analytics platform.', openSource: true },
  },
  {
    slug: 'optimizely', name: 'Optimizely', category: 'analytics',
    icon: 'optimizely', homepage: 'https://www.optimizely.com/',
    rules: [
      script('Optimizely snippet', /cdn\.optimizely\.com\/(?:js|public)\//i),
      { type: 'js-property', source: 'window.optimizely', pattern: /^optimizely$/, confidence: 'high' },
    ],
    metadata: { description: 'Experimentation and personalisation platform.', saas: true },
  },
  {
    slug: 'fullstory', name: 'FullStory', category: 'analytics',
    icon: 'fullstory', homepage: 'https://www.fullstory.com/',
    rules: [
      script('FullStory recording script', /edge\.fullstory\.com\/s\/fs\.js/i),
      { type: 'js-property', source: 'window.FS', pattern: /^FS$/, confidence: 'medium' },
    ],
    metadata: { description: 'Session replay and digital experience analytics.', saas: true },
  },

  /* ───────────── Marketing & CRM ───────────── */
  {
    slug: 'hubspot', name: 'HubSpot', category: 'marketing',
    icon: 'hubspot', homepage: 'https://www.hubspot.com/',
    rules: [
      script('HubSpot tracking script', /js\.hs-scripts\.com\/\d+\.js/i),
      host('HubSpot analytics host', /^js\.hs-analytics\.net$/i),
    ],
    metadata: { description: 'CRM and marketing automation platform.', saas: true },
  },
  {
    slug: 'klaviyo', name: 'Klaviyo', category: 'marketing',
    icon: 'klaviyo', homepage: 'https://www.klaviyo.com/',
    requiresCategory: ['ecommerce', 'cms'],
    rules: [
      script('Klaviyo onsite script', /static\.klaviyo\.com\/onsite\/js\//i),
      host('Klaviyo asset host', /^static[-\w]*\.klaviyo\.com$/i),
    ],
    metadata: { description: 'Ecommerce marketing automation.', saas: true },
  },
  {
    slug: 'mailchimp', name: 'Mailchimp', category: 'marketing',
    icon: 'mailchimp', homepage: 'https://mailchimp.com/',
    rules: [
      script('Mailchimp signup script', /chimpstatic\.com\/mcjs-connected\//i),
      host('Mailchimp list host', /^[\w-]+\.list-manage\.com$/i, 'medium'),
    ],
    metadata: { description: 'Email marketing platform.', saas: true },
  },
  {
    slug: 'intercom', name: 'Intercom', category: 'marketing',
    icon: 'intercom', homepage: 'https://www.intercom.com/',
    rules: [
      script('Intercom widget script', /widget\.intercom\.io\/widget\//i),
      { type: 'js-property', source: 'window.Intercom', pattern: /^Intercom$/, confidence: 'medium' },
    ],
    metadata: { description: 'Customer messaging platform.', saas: true },
  },

  /* ───────────── Payments ───────────── */
  {
    slug: 'adyen', name: 'Adyen', category: 'payments',
    icon: 'adyen', homepage: 'https://www.adyen.com/',
    rules: [
      host('Adyen checkout host', /^checkoutshopper-(?:live|test)\.adyen\.com$/i),
      script('Adyen Web SDK', /checkoutshopper-\w+\.adyen\.com\/checkoutshopper\/sdk\//i),
    ],
    metadata: { description: 'Payment platform.', saas: true },
  },
  {
    slug: 'braintree', name: 'Braintree', category: 'payments',
    icon: 'braintree', homepage: 'https://www.braintreepayments.com/',
    rules: [
      host('Braintree JS host', /^js\.braintreegateway\.com$/i),
      script('Braintree client SDK', /js\.braintreegateway\.com\/web\/(\d+\.\d+\.\d+)\//i, 'high', 1),
    ],
    metadata: { description: 'PayPal-owned payment gateway.', saas: true },
  },
  {
    slug: 'klarna', name: 'Klarna', category: 'payments',
    icon: 'klarna', homepage: 'https://www.klarna.com/',
    rules: [
      host('Klarna CDN host', /^(?:x|osm)\.klarnacdn\.net$/i),
      script('Klarna messaging library', /klarnacdn\.net\/kp\/lib\//i),
    ],
    metadata: { description: 'Buy-now-pay-later payment provider.', saas: true },
  },

  /* ───────────── Infrastructure ───────────── */
  {
    slug: 'akamai', name: 'Akamai', category: 'infrastructure',
    icon: 'akamai', homepage: 'https://www.akamai.com/',
    rules: [
      hdr('x-akamai-transformed', 'x-akamai-transformed header', /.+/),
      hdr('server-timing', 'server-timing Akamai edge marker', /cdn-cache;\s*desc=|akamai/i, 'medium'),
      { type: 'cookie-name', source: 'Akamai bot manager cookie', pattern: /^(?:ak_bmsc|bm_sv)$/, confidence: 'medium' },
    ],
    metadata: { description: 'Global CDN and edge security provider.', saas: true },
  },
  {
    slug: 'bunny', name: 'Bunny.net', category: 'infrastructure',
    icon: 'bunny', homepage: 'https://bunny.net/',
    rules: [
      hdr('server', 'server header', /^BunnyCDN/i),
      host('Bunny CDN host', /\.b-cdn\.net$/i),
    ],
    metadata: { description: 'CDN and edge storage provider.', saas: true },
  },
  {
    slug: 'cloudinary', name: 'Cloudinary', category: 'infrastructure',
    icon: 'cloudinary', homepage: 'https://cloudinary.com/',
    rules: [host('Cloudinary media host', /^res\.cloudinary\.com$/i)],
    metadata: { description: 'Media transformation and delivery platform.', saas: true },
  },
  {
    slug: 'jsdelivr', name: 'jsDelivr', category: 'infrastructure',
    icon: 'jsdelivr', homepage: 'https://www.jsdelivr.com/',
    rules: [host('jsDelivr CDN host', /^cdn\.jsdelivr\.net$/i)],
    metadata: { description: 'Open-source package CDN.', openSource: true },
  },

  /* ───────────── Security ───────────── */
  {
    slug: 'recaptcha', name: 'Google reCAPTCHA', category: 'security',
    icon: 'google', homepage: 'https://www.google.com/recaptcha/about/',
    rules: [
      script('reCAPTCHA API script', /www\.(?:google|recaptcha\.net)\.com?\/recaptcha\/api\.js/i),
      { type: 'dom-selector', source: '.g-recaptcha element', pattern: /^\.g-recaptcha$/, confidence: 'high' },
    ],
    metadata: { description: 'Bot detection and CAPTCHA service.', vendor: 'Google', saas: true },
  },
  {
    slug: 'hcaptcha', name: 'hCaptcha', category: 'security',
    icon: 'hcaptcha', homepage: 'https://www.hcaptcha.com/',
    rules: [
      script('hCaptcha API script', /(?:js|api)\.hcaptcha\.com\/1\/api\.js/i),
      { type: 'dom-selector', source: '.h-captcha element', pattern: /^\.h-captcha$/, confidence: 'high' },
    ],
    metadata: { description: 'Privacy-oriented CAPTCHA service.', saas: true },
  },
  {
    slug: 'turnstile', name: 'Cloudflare Turnstile', category: 'security',
    icon: 'cloudflare', homepage: 'https://www.cloudflare.com/products/turnstile/',
    implies: ['cloudflare'],
    rules: [script('Turnstile API script', /challenges\.cloudflare\.com\/turnstile\/v\d\/api\.js/i)],
    metadata: { description: 'CAPTCHA alternative from Cloudflare.', saas: true },
  },
  {
    slug: 'sucuri', name: 'Sucuri', category: 'security',
    icon: 'sucuri', homepage: 'https://sucuri.net/',
    rules: [
      hdr('x-sucuri-id', 'x-sucuri-id header', /.+/),
      hdr('x-sucuri-cache', 'x-sucuri-cache header', /.+/),
    ],
    metadata: { description: 'Website firewall and malware protection.', saas: true },
  },

  /* ───────────── Consent ───────────── */
  {
    slug: 'onetrust', name: 'OneTrust', category: 'consent',
    icon: 'onetrust', homepage: 'https://www.onetrust.com/',
    rules: [
      script('OneTrust CMP script', /cdn(?:-\w+)?\.(?:onetrust|cookielaw)\.(?:com|org)\/(?:scripttemplates|consent)\//i),
      { type: 'cookie-name', source: 'OneTrust consent cookie', pattern: /^OptanonConsent$/, confidence: 'high' },
    ],
    metadata: { description: 'Consent management platform.', saas: true },
  },
  {
    slug: 'cookiebot', name: 'Cookiebot', category: 'consent',
    icon: 'cookiebot', homepage: 'https://www.cookiebot.com/',
    rules: [
      script('Cookiebot CMP script', /consent\.cookiebot\.com\/uc\.js/i),
      { type: 'cookie-name', source: 'Cookiebot consent cookie', pattern: /^CookieConsent$/, confidence: 'medium' },
    ],
    metadata: { description: 'Consent management platform.', saas: true },
  },
  {
    slug: 'usercentrics', name: 'Usercentrics', category: 'consent',
    icon: 'usercentrics', homepage: 'https://usercentrics.com/',
    rules: [script('Usercentrics CMP script', /app\.usercentrics\.eu\/(?:browser-ui|latest)\//i)],
    metadata: { description: 'Consent management platform.', saas: true },
  },

  /* ───────────── Fonts ───────────── */
  {
    slug: 'google-fonts', name: 'Google Fonts', category: 'fonts',
    icon: 'googlefonts', homepage: 'https://fonts.google.com/',
    rules: [
      host('Google Fonts stylesheet host', /^fonts\.googleapis\.com$/i),
      host('Google Fonts asset host', /^fonts\.gstatic\.com$/i, 'medium'),
    ],
    metadata: { description: 'Hosted webfont library.', vendor: 'Google' },
  },
  {
    slug: 'adobe-fonts', name: 'Adobe Fonts', category: 'fonts',
    icon: 'adobe', homepage: 'https://fonts.adobe.com/',
    rules: [host('Adobe Fonts (Typekit) host', /^use\.typekit\.net$/i)],
    metadata: { description: 'Subscription webfont service.', vendor: 'Adobe', saas: true },
  },
  {
    slug: 'font-awesome', name: 'Font Awesome', category: 'fonts',
    icon: 'fontawesome', homepage: 'https://fontawesome.com/',
    rules: [
      { type: 'stylesheet-url', source: 'Font Awesome stylesheet with version', pattern: /font-?awesome[@/](\d+\.\d+\.\d+)/i, versionGroup: 1, confidence: 'high' },
      host('Font Awesome kit host', /^kit\.fontawesome\.com$/i),
    ],
    metadata: { description: 'Icon font and SVG icon library.' },
  },

  /* ───────────── Search, forms, media ───────────── */
  {
    slug: 'algolia', name: 'Algolia', category: 'search',
    icon: 'algolia', homepage: 'https://www.algolia.com/',
    rules: [
      { type: 'xhr-host', source: 'Algolia search API host', pattern: /\.algolia(?:net|\.net)$/i, confidence: 'high' },
      script('Algolia InstantSearch bundle', /cdn\.jsdelivr\.net\/npm\/(?:algoliasearch|instantsearch)/i, 'medium'),
    ],
    metadata: { description: 'Hosted search and discovery API.', saas: true },
  },
  {
    slug: 'typeform', name: 'Typeform', category: 'forms',
    icon: 'typeform', homepage: 'https://www.typeform.com/',
    rules: [
      script('Typeform embed script', /embed\.typeform\.com\/next\/embed\.js/i),
      { type: 'dom-selector', source: 'data-tf-live embed element', pattern: /^\[data-tf-live\]$/, confidence: 'high' },
    ],
    metadata: { description: 'Conversational form builder.', saas: true },
  },
  {
    slug: 'youtube-embed', name: 'YouTube', category: 'media',
    icon: 'youtube', homepage: 'https://www.youtube.com/',
    rules: [
      host('YouTube embed host', /^www\.youtube(?:-nocookie)?\.com$/i, 'medium'),
      { type: 'dom-selector', source: 'YouTube iframe embed', pattern: /^iframe\[src\*="youtube"\]$/, confidence: 'high' },
    ],
    metadata: { description: 'Video hosting and embedded player.', vendor: 'Google' },
  },
  {
    slug: 'vimeo', name: 'Vimeo', category: 'media',
    icon: 'vimeo', homepage: 'https://vimeo.com/',
    rules: [
      host('Vimeo player host', /^player\.vimeo\.com$/i),
      script('Vimeo player API', /player\.vimeo\.com\/api\/player\.js/i),
    ],
    metadata: { description: 'Video hosting and embedded player.', saas: true },
  },
  {
    slug: 'wistia', name: 'Wistia', category: 'media',
    icon: 'wistia', homepage: 'https://wistia.com/',
    rules: [
      host('Wistia asset host', /^fast\.wistia\.(?:com|net)$/i),
      script('Wistia embed script', /fast\.wistia\.(?:com|net)\/assets\/external\/E-v1\.js/i),
    ],
    metadata: { description: 'Business video hosting.', saas: true },
  },

  /* ───────────── WordPress ecosystem (requires WordPress) ───────────── */
  {
    slug: 'elementor', name: 'Elementor', category: 'plugin',
    icon: 'elementor', homepage: 'https://elementor.com/',
    requires: ['wordpress'],
    rules: [
      { type: 'resource-url', source: 'Elementor plugin asset path', pattern: /\/wp-content\/plugins\/elementor(?:-pro)?\//i, confidence: 'high' },
      { type: 'meta-generator', source: '<meta name="generator">', pattern: /^Elementor\s+([\d.]+)/i, versionGroup: 1, confidence: 'high' },
    ],
    metadata: { description: 'WordPress page builder.', ecosystem: 'wordpress' },
  },
  {
    slug: 'yoast-seo', name: 'Yoast SEO', category: 'plugin',
    icon: 'yoast', homepage: 'https://yoast.com/',
    requires: ['wordpress'],
    rules: [
      { type: 'html-marker', source: 'Yoast SEO HTML comment block', pattern: /<!--\s*This site is optimized with the Yoast SEO plugin v([\d.]+)/i, versionGroup: 1, confidence: 'high' },
      { type: 'resource-url', source: 'Yoast plugin asset path', pattern: /\/wp-content\/plugins\/wordpress-seo\//i, confidence: 'high' },
    ],
    metadata: { description: 'WordPress SEO plugin.', ecosystem: 'wordpress' },
  },
  {
    slug: 'wp-rocket', name: 'WP Rocket', category: 'plugin',
    icon: 'wprocket', homepage: 'https://wp-rocket.me/',
    requires: ['wordpress'],
    rules: [
      { type: 'html-marker', source: 'WP Rocket cache footer comment', pattern: /<!--\s*This website is like a Rocket/i, confidence: 'high' },
      { type: 'resource-url', source: 'WP Rocket plugin asset path', pattern: /\/wp-content\/plugins\/wp-rocket\//i, confidence: 'high' },
    ],
    metadata: { description: 'WordPress caching and performance plugin.', ecosystem: 'wordpress' },
  },
  {
    slug: 'contact-form-7', name: 'Contact Form 7', category: 'forms',
    icon: 'wordpress', homepage: 'https://contactform7.com/',
    requires: ['wordpress'],
    rules: [{ type: 'resource-url', source: 'Contact Form 7 plugin asset path', pattern: /\/wp-content\/plugins\/contact-form-7\//i, confidence: 'high' }],
    metadata: { description: 'WordPress contact form plugin.', ecosystem: 'wordpress' },
  },

  /* ───────────── Shopify ecosystem (requires Shopify) ───────────── */
  {
    slug: 'yotpo', name: 'Yotpo', category: 'plugin',
    icon: 'yotpo', homepage: 'https://www.yotpo.com/',
    requiresCategory: ['ecommerce', 'cms'],
    rules: [
      script('Yotpo widget script', /staticw2\.yotpo\.com\/[\w-]+\/widget\.js/i),
      host('Yotpo asset host', /^staticw2\.yotpo\.com$/i),
    ],
    metadata: { description: 'Reviews and loyalty platform.', saas: true, ecosystem: 'shopify' },
  },
] as const;
