import type {
  TechnologyCategoryId,
  TechnologyConfidence,
  SignalType,
} from './types.js';

/**
 * Declarative detection rules. Every rule states the surface it inspects,
 * what it matches, and the confidence a single such observation justifies.
 *
 * INVARIANTS (enforced by technologyRegistry.test.ts):
 *  - No pattern carries the `g` or `y` flag. Registry regexes are reused
 *    across inputs; a stateful flag would make detection order-dependent.
 *  - No rule uses signal type 'implied-by'; that type is detector-generated.
 *  - Every `implies` target resolves to a registry entry.
 *  - Patterns with a versionGroup expose exactly one capture group.
 */

export interface DetectionRule {
  type: SignalType;
  /** Shown verbatim in evidence, e.g. '<meta name="generator">'. */
  source: string;
  /** Lowercase header name. Required when type === 'response-header'. */
  header?: string;
  /** Attribute name. Required when type === 'dom-attribute'. */
  attribute?: string;
  /** Must be specific. Never global/sticky. */
  pattern: RegExp;
  /** Single capture group index holding a version, if this rule exposes one. */
  versionGroup?: number;
  confidence: TechnologyConfidence;
  /** class-fingerprint only: distinct matches required before firing. */
  minDistinctMatches?: number;
  /** extended-signal metadata, optional on legacy/base rules. */
  versionFromProperty?: boolean;
  probePath?: string;
  expectStatus?: number;
}

export interface TechnologyDefinition {
  slug: string;
  name: string;
  category: TechnologyCategoryId;
  icon: string;
  homepage: string;
  rules: DetectionRule[];
  implies?: string[];
}

/**
 * ICON_STRATEGY
 * -------------
 * `icon` is a Simple Icons slug (simpleicons.org, CC0), vendored at build
 * time to `public/tech-icons/<icon>.svg`. No runtime scraping, no hotlinking.
 *
 * ANCHOR ACTION REQUIRED: Simple Icons periodically renames slugs, and some
 * products have no icon at all. The build step that vendors these assets
 * should FAIL LOUDLY on a missing slug rather than shipping a gap. Known
 * uncertain slugs at time of writing: 'nuxtdotjs', 'amazonaws'. 'microsoft'
 * is a deliberate stand-in for Clarity, which has no dedicated icon.
 * The UI degrades to a generic glyph if an asset is absent.
 */

export const TECHNOLOGY_REGISTRY: readonly TechnologyDefinition[] = [
  /* --------------------------------- CMS --------------------------------- */
  {
    slug: 'wordpress',
    name: 'WordPress',
    category: 'cms',
    icon: 'wordpress',
    homepage: 'https://wordpress.org/',
    rules: [
      {
        type: 'meta-generator',
        source: '<meta name="generator">',
        pattern: /^WordPress(?:\s+([\d.]+))?/i,
        versionGroup: 1,
        confidence: 'high',
      },
      {
        type: 'resource-url',
        source: '/wp-content/ resource path',
        pattern: /\/wp-content\//i,
        confidence: 'high',
      },
      {
        type: 'resource-url',
        source: '/wp-includes/ resource path',
        pattern: /\/wp-includes\//i,
        confidence: 'high',
      },
      {
        type: 'html-marker',
        source: 'WP REST API link element',
        pattern: /<link[^>]+rel=["']https:\/\/api\.w\.org\/["']/i,
        confidence: 'high',
      },
      {
        type: 'cookie-name',
        source: 'WordPress session cookie name',
        pattern: /^wordpress_(?:logged_in_|sec_)/i,
        confidence: 'medium',
      },
    ],
  },
  {
    slug: 'shopify',
    name: 'Shopify',
    category: 'cms',
    icon: 'shopify',
    homepage: 'https://www.shopify.com/',
    // `implies` removed — the former target did not exist in the registry.
    rules: [
      {
        type: 'response-header',
        source: 'x-shopify-stage header',
        header: 'x-shopify-stage',
        pattern: /.+/,
        confidence: 'high',
      },
      {
        type: 'response-header',
        source: 'x-shopid header',
        header: 'x-shopid',
        pattern: /^\d+$/,
        confidence: 'high',
      },
      {
        type: 'request-host',
        source: 'cdn.shopify.com asset host',
        pattern: /^cdn\.shopify\.com$/i,
        confidence: 'high',
      },
      {
        type: 'html-marker',
        source: 'Shopify theme bootstrap object',
        pattern: /Shopify\.theme\s*=|window\.Shopify\s*=/,
        confidence: 'high',
      },
      {
        type: 'cookie-name',
        source: 'Shopify analytics cookie name',
        pattern: /^_shopify_(?:y|s|sa_t)$/i,
        confidence: 'medium',
      },
    ],
  },
  {
    slug: 'webflow',
    name: 'Webflow',
    category: 'cms',
    icon: 'webflow',
    homepage: 'https://webflow.com/',
    rules: [
      {
        type: 'meta-generator',
        source: '<meta name="generator">',
        pattern: /^Webflow/i,
        confidence: 'high',
      },
      {
        type: 'dom-attribute',
        source: 'data-wf-page attribute on root element',
        attribute: 'data-wf-page',
        pattern: /.+/,
        confidence: 'high',
      },
      {
        type: 'request-host',
        source: 'Webflow asset host',
        pattern: /^(?:assets|cdn\.prod)\.website-files\.com$/i,
        confidence: 'high',
      },
    ],
  },
  {
    slug: 'wix',
    name: 'Wix',
    category: 'cms',
    icon: 'wix',
    homepage: 'https://www.wix.com/',
    rules: [
      {
        type: 'meta-generator',
        source: '<meta name="generator">',
        pattern: /^Wix\.com Website Builder/i,
        confidence: 'high',
      },
      {
        type: 'response-header',
        source: 'x-wix-request-id header',
        header: 'x-wix-request-id',
        pattern: /.+/,
        confidence: 'high',
      },
      {
        type: 'request-host',
        source: 'Wix static asset host (parastorage)',
        pattern: /^static\.parastorage\.com$/i,
        confidence: 'medium',
      },
    ],
  },
  {
    slug: 'squarespace',
    name: 'Squarespace',
    category: 'cms',
    icon: 'squarespace',
    homepage: 'https://www.squarespace.com/',
    rules: [
      {
        type: 'meta-generator',
        source: '<meta name="generator">',
        pattern: /^Squarespace/i,
        confidence: 'high',
      },
      {
        type: 'html-marker',
        source: 'Squarespace context object',
        pattern: /Static\.SQUARESPACE_CONTEXT/,
        confidence: 'high',
      },
      {
        type: 'request-host',
        source: 'Squarespace asset host',
        pattern: /^static1\.squarespace\.com$/i,
        confidence: 'high',
      },
    ],
  },
  {
    slug: 'drupal',
    name: 'Drupal',
    category: 'cms',
    icon: 'drupal',
    homepage: 'https://www.drupal.org/',
    rules: [
      {
        type: 'response-header',
        source: 'x-generator header',
        header: 'x-generator',
        pattern: /^Drupal\s+(\d+(?:\.\d+)*)/i,
        versionGroup: 1,
        confidence: 'high',
      },
      {
        type: 'meta-generator',
        source: '<meta name="generator">',
        pattern: /^Drupal\s+(\d+(?:\.\d+)*)/i,
        versionGroup: 1,
        confidence: 'high',
      },
      {
        type: 'html-marker',
        source: 'drupal-settings-json script block',
        pattern: /data-drupal-selector=["']drupal-settings-json["']/i,
        confidence: 'high',
      },
    ],
  },
  {
    slug: 'joomla',
    name: 'Joomla',
    category: 'cms',
    icon: 'joomla',
    homepage: 'https://www.joomla.org/',
    rules: [
      {
        // Joomla's default generator carries no version. Version capture
        // removed rather than guessed.
        type: 'meta-generator',
        source: '<meta name="generator">',
        pattern: /^Joomla!?\b/i,
        confidence: 'high',
      },
      {
        type: 'resource-url',
        source: '/media/system/js/ resource path',
        pattern: /\/media\/system\/js\//i,
        confidence: 'medium',
      },
    ],
  },
  {
    slug: 'ghost',
    name: 'Ghost',
    category: 'cms',
    icon: 'ghost',
    homepage: 'https://ghost.org/',
    rules: [
      {
        type: 'meta-generator',
        source: '<meta name="generator">',
        pattern: /^Ghost(?:\s+([\d.]+))?/i,
        versionGroup: 1,
        confidence: 'high',
      },
      {
        type: 'script-url',
        source: 'Ghost SDK script',
        pattern: /\/ghost\/[^/]*sdk[^/]*\.min\.js/i,
        confidence: 'medium',
      },
    ],
  },

  /* ------------------------ Frameworks & Libraries ----------------------- */
  {
    slug: 'react',
    name: 'React',
    category: 'framework',
    icon: 'react',
    homepage: 'https://react.dev/',
    rules: [
      {
        type: 'runtime-global',
        source: 'React fiber property on a DOM node',
        pattern: /^__react(?:Container|Fiber)\$/,
        confidence: 'high',
      },
      {
        type: 'runtime-global',
        source: 'window.React',
        pattern: /^React$/,
        confidence: 'high',
      },
      {
        type: 'dom-attribute',
        source: 'data-reactroot attribute',
        attribute: 'data-reactroot',
        pattern: /.*/, // presence rule; the attribute is typically empty
        confidence: 'high',
      },
      {
        // Single capture group (was two, with a detector-side fallback).
        type: 'script-url',
        source: 'React CDN bundle with version',
        pattern: /\/react(?:@|\/)(\d+\.\d+\.\d+)/i,
        versionGroup: 1,
        confidence: 'high',
      },
    ],
  },
  {
    slug: 'nextjs',
    name: 'Next.js',
    category: 'framework',
    icon: 'nextdotjs',
    homepage: 'https://nextjs.org/',
    rules: [
      {
        type: 'resource-url',
        source: '/_next/static/ resource path',
        pattern: /\/_next\/static\//i,
        confidence: 'high',
      },
      {
        type: 'html-marker',
        source: '__NEXT_DATA__ script element',
        pattern: /<script[^>]+id=["']__NEXT_DATA__["']/i,
        confidence: 'high',
      },
      {
        type: 'response-header',
        source: 'x-nextjs-cache header',
        header: 'x-nextjs-cache',
        pattern: /.+/,
        confidence: 'high',
      },
      {
        type: 'runtime-global',
        source: 'window.__NEXT_DATA__',
        pattern: /^__NEXT_DATA__$/,
        confidence: 'high',
      },
    ],
    implies: ['react'],
  },
  {
    slug: 'vue',
    name: 'Vue.js',
    category: 'framework',
    icon: 'vuedotjs',
    homepage: 'https://vuejs.org/',
    rules: [
      {
        type: 'runtime-global',
        source: '__vue_app__ on mount element',
        pattern: /^__vue_app__$/,
        confidence: 'high',
      },
      {
        type: 'runtime-global',
        source: 'window.__VUE__ devtools bridge',
        pattern: /^__VUE__$/,
        confidence: 'high',
      },
      {
        type: 'script-url',
        source: 'Vue CDN bundle with version',
        pattern: /\/vue(?:@|\/)(\d+\.\d+\.\d+)/i,
        versionGroup: 1,
        confidence: 'high',
      },
      {
        type: 'dom-attribute',
        source: 'data-server-rendered attribute (Vue 2 SSR)',
        attribute: 'data-server-rendered',
        pattern: /^true$/i,
        confidence: 'medium',
      },
    ],
  },
  {
    slug: 'nuxt',
    name: 'Nuxt',
    category: 'framework',
    icon: 'nuxtdotjs',
    homepage: 'https://nuxt.com/',
    rules: [
      {
        type: 'resource-url',
        source: '/_nuxt/ resource path',
        pattern: /\/_nuxt\//i,
        confidence: 'high',
      },
      {
        type: 'html-marker',
        source: 'Nuxt mount point',
        pattern: /<div[^>]+id=["']__nuxt["']/i,
        confidence: 'high',
      },
      {
        type: 'runtime-global',
        source: 'window.__NUXT__',
        pattern: /^__NUXT__$/,
        confidence: 'high',
      },
    ],
    implies: ['vue'],
  },
  {
    slug: 'angular',
    name: 'Angular',
    category: 'framework',
    icon: 'angular',
    homepage: 'https://angular.dev/',
    rules: [
      {
        type: 'dom-attribute',
        source: 'ng-version attribute',
        attribute: 'ng-version',
        pattern: /^(\d+\.\d+\.\d+)/,
        versionGroup: 1,
        confidence: 'high',
      },
      {
        // Downgraded: `ng` is a 2-character global with real collision risk.
        // Alone it is tentative only; it corroborates ng-version.
        type: 'runtime-global',
        source: 'window.ng runtime namespace',
        pattern: /^ng$/,
        confidence: 'low',
      },
    ],
  },
  {
    slug: 'svelte',
    name: 'Svelte',
    category: 'framework',
    icon: 'svelte',
    homepage: 'https://svelte.dev/',
    rules: [
      {
        type: 'resource-url',
        source: 'SvelteKit immutable asset path',
        pattern: /\/_app\/immutable\//i,
        confidence: 'high',
      },
      {
        type: 'runtime-global',
        source: '__sveltekit runtime namespace',
        pattern: /^__sveltekit(?:_|$)/,
        confidence: 'high',
      },
    ],
  },
  {
    slug: 'jquery',
    name: 'jQuery',
    category: 'framework',
    icon: 'jquery',
    homepage: 'https://jquery.com/',
    rules: [
      {
        type: 'runtime-global',
        source: 'window.jQuery',
        pattern: /^jQuery$/,
        confidence: 'high',
      },
      {
        type: 'script-url',
        source: 'jQuery script filename with version',
        pattern: /\/jquery[-.](\d+\.\d+\.\d+)(?:\.slim)?(?:\.min)?\.js/i,
        versionGroup: 1,
        confidence: 'high',
      },
      {
        type: 'script-url',
        source: 'jQuery script filename',
        pattern: /\/jquery(?:\.slim)?(?:\.min)?\.js/i,
        confidence: 'medium',
      },
    ],
  },
  {
    slug: 'bootstrap',
    name: 'Bootstrap',
    category: 'framework',
    icon: 'bootstrap',
    homepage: 'https://getbootstrap.com/',
    rules: [
      {
        type: 'stylesheet-url',
        source: 'Bootstrap stylesheet with version',
        pattern: /bootstrap[@/-](\d+\.\d+\.\d+)/i,
        versionGroup: 1,
        confidence: 'high',
      },
      {
        type: 'script-url',
        source: 'Bootstrap bundle script',
        pattern: /\/bootstrap(?:\.bundle)?(?:\.min)?\.js/i,
        confidence: 'medium',
      },
      {
        type: 'stylesheet-url',
        source: 'Bootstrap stylesheet',
        pattern: /\/bootstrap(?:\.min)?\.css/i,
        confidence: 'medium',
      },
    ],
  },
  {
    slug: 'tailwindcss',
    name: 'Tailwind CSS',
    category: 'framework',
    icon: 'tailwindcss',
    homepage: 'https://tailwindcss.com/',
    rules: [
      {
        type: 'request-host',
        source: 'Tailwind Play CDN',
        pattern: /^cdn\.tailwindcss\.com$/i,
        confidence: 'high',
      },
      {
        type: 'stylesheet-url',
        source: 'Tailwind stylesheet filename',
        pattern: /tailwind(?:\.min)?\.css/i,
        confidence: 'medium',
      },
      {
        /**
         * Requires 4 DISTINCT variant-prefixed or Tailwind-idiomatic
         * utilities. Bare generic names (flex, grid, block) are excluded
         * because they collide with hand-written CSS.
         * NOTE: no `g` flag here — the detector adds it locally.
         */
        type: 'class-fingerprint',
        source: 'Tailwind utility class fingerprint',
        pattern:
          /\b(?:sm|md|lg|xl|2xl|hover|focus|dark|group-hover):[a-z][a-z0-9-]*\b|\b(?:space-[xy]-\d|divide-[xy]|ring-\d|antialiased|shrink-0|inset-0|tracking-tight|leading-none)\b/,
        minDistinctMatches: 4,
        confidence: 'medium',
      },
    ],
  },

  /* ------------------------------ Analytics ------------------------------ */
  {
    slug: 'google-analytics',
    name: 'Google Analytics',
    category: 'analytics',
    icon: 'googleanalytics',
    homepage: 'https://marketingplatform.google.com/about/analytics/',
    rules: [
      {
        type: 'script-url',
        source: 'GA4 gtag.js loader',
        pattern: /googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]+/i,
        confidence: 'high',
      },
      {
        type: 'script-url',
        source: 'Universal Analytics analytics.js',
        pattern: /google-analytics\.com\/(?:analytics|ga)\.js/i,
        confidence: 'high',
      },
      {
        // Widened to cover GA4 regional collection endpoints.
        type: 'request-host',
        source: 'GA measurement endpoint',
        pattern: /^(?:(?:www|region\d+)\.)?google-analytics\.com$/i,
        confidence: 'high',
      },
    ],
  },
  {
    slug: 'google-tag-manager',
    name: 'Google Tag Manager',
    category: 'analytics',
    icon: 'googletagmanager',
    // Was tagmanager.google.com (an app sign-in), now the product page.
    homepage: 'https://marketingplatform.google.com/about/tag-manager/',
    rules: [
      {
        type: 'script-url',
        source: 'GTM container loader',
        pattern: /googletagmanager\.com\/gtm\.js\?id=GTM-[A-Z0-9]+/i,
        confidence: 'high',
      },
      {
        type: 'html-marker',
        source: 'GTM noscript iframe',
        pattern: /googletagmanager\.com\/ns\.html\?id=GTM-[A-Z0-9]+/i,
        confidence: 'high',
      },
    ],
  },
  {
    slug: 'meta-pixel',
    name: 'Meta Pixel',
    category: 'analytics',
    icon: 'meta',
    homepage: 'https://www.facebook.com/business/tools/meta-pixel',
    rules: [
      {
        type: 'script-url',
        source: 'Meta Pixel fbevents.js',
        pattern: /connect\.facebook\.net\/[^/]+\/fbevents\.js/i,
        confidence: 'high',
      },
      {
        // Replaces the deleted www.facebook.com host rule, which fired on
        // any share button, like box, or comment embed.
        type: 'html-marker',
        source: "fbq('init') pixel initialisation call",
        pattern: /\bfbq\s*\(\s*['"]init['"]\s*,/,
        confidence: 'high',
      },
    ],
  },
  {
    slug: 'hotjar',
    name: 'Hotjar',
    category: 'analytics',
    icon: 'hotjar',
    homepage: 'https://www.hotjar.com/',
    rules: [
      {
        type: 'script-url',
        source: 'Hotjar site script',
        pattern: /static\.hotjar\.com\/c\/hotjar-\d+\.js/i,
        confidence: 'high',
      },
      {
        type: 'request-host',
        source: 'Hotjar script host',
        pattern: /^static\.hotjar\.com$/i,
        confidence: 'high',
      },
    ],
  },
  {
    slug: 'microsoft-clarity',
    name: 'Microsoft Clarity',
    category: 'analytics',
    icon: 'microsoft',
    homepage: 'https://clarity.microsoft.com/',
    rules: [
      {
        type: 'script-url',
        source: 'Clarity tag script',
        pattern: /clarity\.ms\/tag\/[a-z0-9]+/i,
        confidence: 'high',
      },
      {
        type: 'request-host',
        source: 'Clarity ingest host',
        pattern: /^(?:www\.)?clarity\.ms$/i,
        confidence: 'high',
      },
    ],
  },

  /* ------------------------------ Ecommerce ------------------------------ */
  {
    slug: 'woocommerce',
    name: 'WooCommerce',
    category: 'ecommerce',
    icon: 'woocommerce',
    homepage: 'https://woocommerce.com/',
    rules: [
      {
        type: 'resource-url',
        source: 'WooCommerce plugin asset path',
        pattern: /\/wp-content\/plugins\/woocommerce\//i,
        confidence: 'high',
      },
      {
        type: 'html-marker',
        source: 'WooCommerce body class',
        pattern: /<body[^>]+class=["'][^"']*\bwoocommerce(?:-page)?\b/i,
        confidence: 'medium',
      },
      {
        type: 'cookie-name',
        source: 'WooCommerce cart cookie name',
        pattern: /^woocommerce_(?:items_in_cart|cart_hash)$/i,
        confidence: 'medium',
      },
    ],
    implies: ['wordpress'],
  },

  /* ------------------------------- Payments ------------------------------ */
  {
    slug: 'stripe',
    name: 'Stripe',
    category: 'payments',
    icon: 'stripe',
    homepage: 'https://stripe.com/',
    rules: [
      {
        type: 'script-url',
        source: 'Stripe.js loader',
        pattern: /js\.stripe\.com\/v\d+/i,
        confidence: 'high',
      },
      {
        type: 'request-host',
        source: 'Stripe script host',
        pattern: /^js\.stripe\.com$/i,
        confidence: 'high',
      },
    ],
  },
  {
    slug: 'paypal',
    name: 'PayPal',
    category: 'payments',
    icon: 'paypal',
    homepage: 'https://www.paypal.com/',
    rules: [
      {
        type: 'script-url',
        source: 'PayPal JS SDK',
        pattern: /www\.paypal\.com\/sdk\/js/i,
        confidence: 'high',
      },
      {
        // Downgraded: this host commonly serves only a static
        // "we accept PayPal" logo, which is not an integration.
        type: 'request-host',
        source: 'PayPal static asset host',
        pattern: /^www\.paypalobjects\.com$/i,
        confidence: 'low',
      },
    ],
  },

  /* -------------------------- CDN / Infrastructure ----------------------- */
  {
    slug: 'cloudflare',
    name: 'Cloudflare',
    category: 'infrastructure',
    icon: 'cloudflare',
    homepage: 'https://www.cloudflare.com/',
    rules: [
      {
        type: 'response-header',
        source: 'cf-ray header',
        header: 'cf-ray',
        pattern: /.+/,
        confidence: 'high',
      },
      {
        type: 'response-header',
        source: 'server header',
        header: 'server',
        pattern: /^cloudflare$/i,
        confidence: 'high',
      },
      {
        type: 'response-header',
        source: 'cf-cache-status header',
        header: 'cf-cache-status',
        pattern: /.+/,
        confidence: 'high',
      },
      {
        type: 'cookie-name',
        source: 'Cloudflare bot management cookie name',
        pattern: /^(?:__cf_bm|cf_clearance)$/,
        confidence: 'medium',
      },
    ],
  },
  {
    slug: 'fastly',
    name: 'Fastly',
    category: 'infrastructure',
    icon: 'fastly',
    homepage: 'https://www.fastly.com/',
    rules: [
      {
        type: 'response-header',
        source: 'x-fastly-request-id header',
        header: 'x-fastly-request-id',
        pattern: /.+/,
        confidence: 'high',
      },
      {
        type: 'response-header',
        source: 'fastly-io-info header',
        header: 'fastly-io-info',
        pattern: /.+/,
        confidence: 'high',
      },
      {
        /**
         * Tightened. Fastly POP nodes look like `cache-lhr7333-LHR`, and
         * shielded requests chain them comma-separated. The previous
         * pattern (`^cache-[a-z]{3}\d+`) also matched generic Varnish
         * deployments that set x-served-by.
         */
        type: 'response-header',
        source: 'x-served-by Fastly POP node',
        header: 'x-served-by',
        pattern: /(?:^|,\s*)cache-[a-z]{3,4}\d{3,5}-[A-Z]{3,4}\b/,
        confidence: 'medium',
      },
    ],
  },
  {
    slug: 'vercel',
    name: 'Vercel',
    category: 'infrastructure',
    icon: 'vercel',
    homepage: 'https://vercel.com/',
    rules: [
      {
        type: 'response-header',
        source: 'x-vercel-id header',
        header: 'x-vercel-id',
        pattern: /.+/,
        confidence: 'high',
      },
      {
        type: 'response-header',
        source: 'server header',
        header: 'server',
        pattern: /^Vercel$/i,
        confidence: 'high',
      },
      {
        type: 'response-header',
        source: 'x-vercel-cache header',
        header: 'x-vercel-cache',
        pattern: /.+/,
        confidence: 'high',
      },
    ],
  },
  {
    slug: 'netlify',
    name: 'Netlify',
    category: 'infrastructure',
    icon: 'netlify',
    homepage: 'https://www.netlify.com/',
    rules: [
      {
        type: 'response-header',
        source: 'x-nf-request-id header',
        header: 'x-nf-request-id',
        pattern: /.+/,
        confidence: 'high',
      },
      {
        type: 'response-header',
        source: 'server header',
        header: 'server',
        pattern: /^Netlify$/i,
        confidence: 'high',
      },
    ],
  },
  {
    slug: 'amazon-cloudfront',
    name: 'Amazon CloudFront',
    category: 'infrastructure',
    icon: 'amazonaws',
    homepage: 'https://aws.amazon.com/cloudfront/',
    rules: [
      {
        type: 'response-header',
        source: 'x-amz-cf-id header',
        header: 'x-amz-cf-id',
        pattern: /.+/,
        confidence: 'high',
      },
      {
        type: 'response-header',
        source: 'via header',
        header: 'via',
        pattern: /cloudfront\.net/i,
        confidence: 'high',
      },
    ],
  },

  /* ------------------------ Additional common tools ----------------------- */
  {
    slug: 'elementor',
    name: 'Elementor',
    category: 'other',
    icon: 'elementor',
    homepage: 'https://elementor.com/',
    rules: [{
      type: 'resource-url',
      source: 'Elementor plugin asset path',
      pattern: /\/wp-content\/plugins\/elementor(?:\-|\/)/i,
      confidence: 'high',
    }],
    implies: ['wordpress'],
  },
  {
    slug: 'yoast-seo',
    name: 'Yoast SEO',
    category: 'other',
    icon: 'yoast',
    homepage: 'https://yoast.com/',
    rules: [{
      type: 'resource-url',
      source: 'Yoast SEO plugin asset path',
      pattern: /\/wp-content\/plugins\/wordpress-seo(?:\/|-)/i,
      confidence: 'high',
    }],
    implies: ['wordpress'],
  },
  {
    slug: 'segment',
    name: 'Segment',
    category: 'analytics',
    icon: 'segment',
    homepage: 'https://segment.com/',
    rules: [{
      type: 'request-host',
      source: 'Segment analytics host',
      pattern: /^(?:cdn|api)\.segment\.com$/i,
      confidence: 'high',
    }, {
      type: 'script-url',
      source: 'Segment analytics.js',
      pattern: /segment\.com\/analytics\.js/i,
      confidence: 'high',
    }],
  },
  {
    slug: 'mixpanel',
    name: 'Mixpanel',
    category: 'analytics',
    icon: 'mixpanel',
    homepage: 'https://mixpanel.com/',
    rules: [{
      type: 'request-host',
      source: 'Mixpanel analytics host',
      pattern: /^(?:api|cdn)\.mixpanel\.com$/i,
      confidence: 'high',
    }],
  },
  {
    slug: 'plausible',
    name: 'Plausible Analytics',
    category: 'analytics',
    icon: 'plausibleanalytics',
    homepage: 'https://plausible.io/',
    rules: [{
      type: 'request-host',
      source: 'Plausible analytics host',
      pattern: /^plausible\.io$/i,
      confidence: 'high',
    }, {
      type: 'script-url',
      source: 'Plausible analytics script',
      pattern: /plausible\.io\/js\/script/i,
      confidence: 'high',
    }],
  },
  {
    slug: 'sentry',
    name: 'Sentry',
    category: 'other',
    icon: 'sentry',
    homepage: 'https://sentry.io/',
    rules: [{
      type: 'request-host',
      source: 'Sentry ingest host',
      pattern: /^(?:o\d+\.ingest\.|ingest\.)sentry\.io$/i,
      confidence: 'high',
    }, {
      type: 'script-url',
      source: 'Sentry browser SDK',
      pattern: /browser\.sentry-cdn\.com\//i,
      confidence: 'high',
    }],
  },
  {
    slug: 'intercom',
    name: 'Intercom',
    category: 'other',
    icon: 'intercom',
    homepage: 'https://www.intercom.com/',
    rules: [{
      type: 'request-host',
      source: 'Intercom widget host',
      pattern: /^(?:widget\.intercom\.io|js\.intercomcdn\.com)$/i,
      confidence: 'high',
    }],
  },
  {
    slug: 'zendesk',
    name: 'Zendesk',
    category: 'other',
    icon: 'zendesk',
    homepage: 'https://www.zendesk.com/',
    rules: [{
      type: 'request-host',
      source: 'Zendesk widget host',
      pattern: /^static\.zdassets\.com$/i,
      confidence: 'high',
    }, {
      type: 'script-url',
      source: 'Zendesk widget script',
      pattern: /static\.zdassets\.com\/ekr\/snippet\.js/i,
      confidence: 'high',
    }],
  },
  {
    slug: 'hubspot',
    name: 'HubSpot',
    category: 'analytics',
    icon: 'hubspot',
    homepage: 'https://www.hubspot.com/',
    rules: [{
      type: 'script-url',
      source: 'HubSpot tracking script',
      pattern: /js\.hs-scripts\.com\/\d+\.js/i,
      confidence: 'high',
    }, {
      type: 'request-host',
      source: 'HubSpot analytics host',
      pattern: /^(?:js\.hs-scripts\.com|track\.hubspot\.com)$/i,
      confidence: 'high',
    }],
  },
  {
    slug: 'recaptcha',
    name: 'reCAPTCHA',
    category: 'other',
    icon: 'recaptcha',
    homepage: 'https://www.google.com/recaptcha/',
    rules: [{
      type: 'script-url',
      source: 'Google reCAPTCHA API script',
      pattern: /google\.com\/recaptcha\/api\.js/i,
      confidence: 'high',
    }],
  },
] as const;

export const REGISTRY_BY_SLUG: ReadonlyMap<string, TechnologyDefinition> =
  new Map(TECHNOLOGY_REGISTRY.map((t) => [t.slug, t]));
