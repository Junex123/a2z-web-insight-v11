import type { TechnologyCategoryId, TechnologyMetadata } from '../types.js';
import type { DetectionRule } from '../technologyRegistry.js';

/**
 * Overlays attach relationships, metadata, and additional rules to
 * technologies that ALREADY EXIST in V10's registry, without editing that
 * file. This is deliberate: I cannot see whether V10 modified the base
 * registry after integration, so composition is safer than rewriting.
 *
 * Every overlay slug is asserted to resolve by registryGraph.test.ts.
 */
export interface RegistryOverlay {
  slug: string;
  requires?: string[];
  excludes?: string[];
  requiresCategory?: TechnologyCategoryId[];
  metadata?: TechnologyMetadata;
  /** Rules appended to the base entry's rules. Never replaces them. */
  additionalRules?: DetectionRule[];
}

export const REGISTRY_OVERLAYS: readonly RegistryOverlay[] = [
  {
    slug: 'wordpress',
    metadata: {
      description: 'Open-source PHP content management system.',
      vendor: 'WordPress Foundation',
      openSource: true, saas: false, ecosystem: 'wordpress',
      aliases: ['wp'],
    },
    additionalRules: [
      {
        type: 'robots-txt',
        source: 'robots.txt /wp-admin/ disallow',
        pattern: /^\s*Disallow:\s*\/wp-admin\//im,
        confidence: 'medium',
      },
      {
        type: 'url-pattern',
        source: '/wp-json/ REST route',
        pattern: /\/wp-json(?:\/|$)/i,
        confidence: 'medium',
      },
    ],
  },
  {
    slug: 'woocommerce',
    // Was implies-only. Now a hard dependency: WooCommerce cannot exist
    // without WordPress, so a lone Woo signal must not stand alone.
    requires: ['wordpress'],
    metadata: {
      description: 'Ecommerce plugin for WordPress.',
      vendor: 'Automattic', openSource: true, ecosystem: 'wordpress',
    },
  },
  {
    slug: 'shopify',
    // A site is not simultaneously Shopify-hosted and WordPress-hosted.
    excludes: ['wordpress', 'drupal', 'joomla'],
    metadata: {
      description: 'Hosted ecommerce platform.',
      vendor: 'Shopify Inc.', openSource: false, saas: true,
      ecosystem: 'shopify',
    },
  },
  { slug: 'wix',         excludes: ['wordpress', 'drupal', 'joomla'] },
  { slug: 'squarespace', excludes: ['wordpress', 'drupal', 'joomla'] },
  { slug: 'webflow',     excludes: ['wordpress', 'drupal', 'joomla'] },
  {
    slug: 'nextjs',
    metadata: {
      description: 'React framework with SSR and static generation.',
      vendor: 'Vercel', openSource: true, ecosystem: 'react',
    },
    additionalRules: [
      {
        type: 'js-property',
        source: 'window.next router object',
        pattern: /^next\.router$/,
        confidence: 'high',
      },
    ],
  },
  {
    slug: 'react',
    metadata: {
      description: 'JavaScript library for building user interfaces.',
      vendor: 'Meta', openSource: true, ecosystem: 'react',
    },
    additionalRules: [
      {
        type: 'js-property',
        source: 'React.version runtime property',
        pattern: /^React\.version$/,
        confidence: 'high',
        versionFromProperty: true,
      },
    ],
  },
  {
    slug: 'cloudflare',
    metadata: {
      description: 'CDN, DNS, and edge security platform.',
      vendor: 'Cloudflare, Inc.', saas: true,
    },
    additionalRules: [
      {
        type: 'cert-issuer',
        source: 'TLS certificate issuer',
        pattern: /Cloudflare,?\s*Inc/i,
        confidence: 'medium',
      },
    ],
  },
  {
    slug: 'jquery',
    metadata: {
      description: 'Legacy DOM manipulation library.',
      openSource: true,
    },
    additionalRules: [
      {
        type: 'js-property',
        source: 'jQuery.fn.jquery version string',
        pattern: /^jQuery\.fn\.jquery$/,
        confidence: 'high',
        versionFromProperty: true,
      },
    ],
  },
  {
    slug: 'google-analytics',
    metadata: { description: 'Web analytics platform.', vendor: 'Google', saas: true },
    additionalRules: [
      {
        type: 'xhr-host',
        source: 'GA collect endpoint XHR',
        pattern: /^(?:www|region\d+)\.google-analytics\.com$/i,
        confidence: 'high',
      },
    ],
  },
  { slug: 'stripe',  metadata: { description: 'Payment processing platform.', vendor: 'Stripe, Inc.', saas: true } },
  { slug: 'vercel',  metadata: { description: 'Frontend cloud and edge platform.', vendor: 'Vercel', saas: true } },
  { slug: 'netlify', metadata: { description: 'Web hosting and edge platform.', vendor: 'Netlify', saas: true } },
  { slug: 'nuxt',    metadata: { description: 'Vue framework with SSR.', openSource: true, ecosystem: 'vue' } },
  { slug: 'drupal',  metadata: { description: 'Open-source PHP CMS.', openSource: true, ecosystem: 'drupal' } },
] as const;
