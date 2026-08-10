import { createServer } from 'node:http';

/**
 * A minimal stand-in for the `/public/*` API surface, used only by the
 * Playwright config's `webServer` entry (see ../../playwright.config.ts).
 * This sandbox has no Docker / live Postgres (the same standing
 * limitation noted in every backend phase report), so there is no real
 * API + seeded restaurant to browser-test the new SSR page against.
 * Rather than skip browser coverage of Phase 7's customer ordering page
 * entirely, this serves fixed JSON for one canned restaurant — enough
 * to exercise the real page/component code (SSR fetch, category nav,
 * search, cart persistence, keyboard flow) end-to-end in a real
 * browser, with only the network boundary faked. Plain `node:http` and
 * plain JS (not TypeScript) — Playwright's `webServer` runs this
 * directly with `node`, and apps/web has no TS-loader devDependency to
 * run a `.ts` script standalone; there's nothing here worth adding one
 * for.
 */

export const MOCK_API_PORT = 4310;

const RESTAURANT = {
  slug: 'spice-route',
  name: 'Spice Route',
  description: 'Authentic South Indian food, made fresh to order.',
  timezone: 'Asia/Kolkata',
  status: 'ACTIVE',
  avgPrepMinutes: 20,
  ratingAvg: 4.5,
  ratingCount: 128,
  availability: { accepting: true, reason: 'ACCEPTING' },
  address: {
    line1: '123 MG Road',
    line2: null,
    locality: 'Indiranagar',
    city: 'Bengaluru',
    state: 'Karnataka',
    postalCode: '560001',
    latitude: 12.97,
    longitude: 77.59,
    landmark: null,
  },
  branding: {
    logoUrl: null,
    coverImageUrl: null,
    themePrimaryColor: '#ff5722',
    themeAccentColor: null,
    tagline: 'Taste of the South',
  },
  settings: {
    minOrderAmountMinor: '10000',
    packagingFeeMinor: '2000',
    deliveryFeeMode: 'FLAT',
    deliveryFeeFlatMinor: '3000',
    acceptsOnlinePayment: true,
  },
  hours: [{ dayOfWeek: new Date().getDay(), opensAt: '00:00', closesAt: '23:59', isClosed: false }],
};

const MENU = {
  categories: [
    {
      id: 'cat-starters',
      name: 'Starters',
      description: 'Small plates to start',
      displayOrder: 0,
      items: [
        {
          id: 'item-idli',
          categoryId: 'cat-starters',
          name: 'Idli Sambar',
          description: 'Steamed rice cakes with lentil soup',
          priceMinor: '8000',
          currency: 'INR',
          imageUrl: null,
          isAvailable: true,
          dietaryTag: 'VEG',
          displayOrder: 0,
        },
        {
          id: 'item-vada',
          categoryId: 'cat-starters',
          name: 'Medu Vada',
          description: 'Crispy lentil doughnuts',
          priceMinor: '7000',
          currency: 'INR',
          imageUrl: null,
          isAvailable: false,
          dietaryTag: 'VEG',
          displayOrder: 1,
        },
      ],
    },
    {
      id: 'cat-mains',
      name: 'Mains',
      description: null,
      displayOrder: 1,
      items: [
        {
          id: 'item-dosa',
          categoryId: 'cat-mains',
          name: 'Masala Dosa',
          description: 'Crisp rice crepe with spiced potato filling',
          priceMinor: '12000',
          currency: 'INR',
          imageUrl: null,
          isAvailable: true,
          dietaryTag: 'VEG',
          displayOrder: 0,
        },
      ],
    },
  ],
};

// A second, distinct restaurant — exists specifically so the "cart
// rejects cross-restaurant items" journey has two real slugs to
// navigate between and check localStorage isolation against.
const RESTAURANT_2 = {
  ...RESTAURANT,
  slug: 'copper-kettle',
  name: 'Copper Kettle',
  description: 'North Indian comfort food.',
  branding: { ...RESTAURANT.branding, tagline: 'Home-style curries' },
};

const MENU_2 = {
  categories: [
    {
      id: 'cat-mains-2',
      name: 'Mains',
      description: null,
      displayOrder: 0,
      items: [
        {
          id: 'item-paneer',
          categoryId: 'cat-mains-2',
          name: 'Paneer Butter Masala',
          description: 'Cottage cheese in a rich tomato gravy',
          priceMinor: '18000',
          currency: 'INR',
          imageUrl: null,
          isAvailable: true,
          dietaryTag: 'VEG',
          displayOrder: 0,
        },
      ],
    },
  ],
};

const RESTAURANTS = { [RESTAURANT.slug]: RESTAURANT, [RESTAURANT_2.slug]: RESTAURANT_2 };
const MENUS = { [RESTAURANT.slug]: MENU, [RESTAURANT_2.slug]: MENU_2 };

function envelope(data) {
  return JSON.stringify({ data, meta: { requestId: 'mock' } });
}

function notFoundEnvelope() {
  return JSON.stringify({
    error: { code: 'NOT_FOUND', message: 'Restaurant not found.', requestId: 'mock' },
  });
}

function unauthenticatedEnvelope() {
  return JSON.stringify({
    error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.', requestId: 'mock' },
  });
}

export function startMockPublicApiServer() {
  const server = createServer((req, res) => {
    // The Next.js app runs on a different origin/port (localhost:3000)
    // than this mock (localhost:4310) — `api-client.ts`'s
    // `credentials: 'include'` fetch needs a real CORS response, not a
    // connection-level failure, or SessionProvider's root-layout
    // session check logs a console error on every single page, not
    // just this test file's own pages (see session-context.tsx: a
    // *network* failure is deliberately surfaced via console.error, so
    // it can be debugged — only an actual 401 response means "not
    // logged in" and is swallowed silently).
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    const url = req.url ?? '';

    if (url === '/api/v1/auth/me') {
      res.statusCode = 401;
      res.end(unauthenticatedEnvelope());
      return;
    }

    const match = /^\/api\/v1\/public\/restaurants\/([^/]+)(\/menu)?$/.exec(url);

    if (match) {
      const [, slug, isMenu] = match;
      const restaurant = RESTAURANTS[slug];
      if (restaurant) {
        res.statusCode = 200;
        res.end(envelope(isMenu ? MENUS[slug] : restaurant));
        return;
      }
    }
    res.statusCode = 404;
    res.end(notFoundEnvelope());
  });

  server.listen(MOCK_API_PORT);
  return server;
}

startMockPublicApiServer();
console.log(`Mock public API listening on http://localhost:${MOCK_API_PORT}`);
