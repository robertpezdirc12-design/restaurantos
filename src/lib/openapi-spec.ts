/**
 * OSS-5 (v1.201.0) — Odprta API specifikacija (OrderRestro Swagger vzorec,
 * glej docs/GAP-ANALIZA-odprtokodna-konkurenca.md): statičen OpenAPI 3.0.3 opis
 * JAVNE/integracijske površine RestaurantOS-a, posredovan prek GET /api/openapi.
 *
 * Obseg je ZAKLENJEN na dejansko javno površino (avditirovano @ v1.201.0):
 *   /api/health                          GET
 *   /api/public/menu                     GET
 *   /api/public/menu/availability        GET
 *   /api/public/orders                   POST
 *   /api/public/orders/status            GET
 *   /api/public/pay/{token}              GET, POST
 *   /api/public/reservations             GET, POST
 *   /api/public/feedback                 POST
 *   /api/public/crm/unsubscribe          GET, POST
 *   /api/public/label-status             GET
 *   /api/public/stripe/webhook           POST
 *   /api/public/web-portal               GET, POST
 *   /api/public/web-portal/status        GET
 *   /api/sync                            GET, POST
 *
 * Pravila tega modula:
 *  - ČIST (brez uvozov): verzija pride kot ARGUMENT (route poda APP_VERSION) —
 *    deterministično testaben, client-bundle varen;
 *  - ISKRENO: opisuje le to, kar rute res delajo (auth mehanizmi, rate limiti,
 *    odgovori) — nič "planned", nič okrasnega;
 *  - BREZ SKRIVNOSTI: spec vsebuje le IMENA parametrov (qr, token, X-Device-Token),
 *    nikoli vrednosti — tests/v201-openapi.test.ts to preverja;
 *  - prevajanje: spec je tehnični dokument za integratorje → EN (industrijska
 *    konvencija OpenAPI); uporabniški UI ostaja SL/HR.
 */

export const OPENAPI_VERSION = '3.0.3'

/** Rate-limit konstante iz rute (živ vir resnice je src/lib/guest.ts; tukaj zrcaljeno za opis). */
const RL = {
  menu: '60 requests/min per IP',
  order: '10 orders/min per IP+token',
  status: '60 requests/min per IP',
  feedback: '5 submissions/min per IP',
  label: '60 requests/min per IP',
} as const

const RATE_429 = {
  description: 'Rate limit exceeded (public surface is throttled per IP).',
} as const

const BAD_400 = { description: 'Invalid request body or parameters.' } as const

const NOT_FOUND_404 = { description: 'Unknown or revoked token — generic response, no existence leak.' } as const

/**
 * Zgradi spec (nova objektna struktura ob vsakem klicu — klicatelj si ne more
 * pokvariti deljenega stanja). `version` = aplikacijska verzija (APP_VERSION).
 */
export function buildOpenApiSpec(version: string): Record<string, unknown> {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'RestaurantOS Public API',
      version,
      description:
        'Open specification of the PUBLIC and integration surface of RestaurantOS ' +
        '(guest QR ordering, kiosk devices, pay links, reservations, feedback, CRM ' +
        'opt-out, label status, Stripe webhooks, web portal, offline POS sync). ' +
        'Authenticated staff/backoffice APIs are out of scope by design.',
      license: { name: 'Proprietary' },
    },
    servers: [{ url: '/', description: 'Same-origin deployment' }],
    tags: [
      { name: 'health', description: 'Deployment health probe' },
      { name: 'guest', description: 'QR self-order and kiosk surface' },
      { name: 'paylink', description: 'Online payment links (Stripe)' },
      { name: 'reservations', description: 'Public reservation widget' },
      { name: 'feedback', description: 'Guest feedback (QR)' },
      { name: 'crm', description: 'Marketing opt-out' },
      { name: 'labels', description: 'Production label status (QR)' },
      { name: 'stripe', description: 'Stripe webhook receiver' },
      { name: 'web-portal', description: 'Own web ordering portal (/s/<token>)' },
      { name: 'sync', description: 'Offline POS queue synchronization (authenticated staff)' },
    ],
    components: {
      securitySchemes: {
        QrToken: { type: 'apiKey', in: 'query', name: 'qr', description: 'Per-table QR token (secret, resolved server-side).' },
        DeviceToken: { type: 'apiKey', in: 'header', name: 'X-Device-Token', description: 'Registered kiosk device token.' },
        PortalToken: { type: 'apiKey', in: 'query', name: 'token', description: 'Web portal / reservation widget / label token (32-hex secret).' },
        PayLinkToken: { type: 'apiKey', in: 'path', name: 'token', description: 'Pay link token (32-hex secret, shape-checked server-side).' },
        StripeSignature: { type: 'apiKey', in: 'header', name: 'Stripe-Signature', description: 'Stripe webhook signature (verified against the configured secret).' },
        SessionAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Staff session token issued by /api/auth (same as dashboard).' },
      },
    },
    paths: {
      '/api/health': {
        get: {
          tags: ['health'],
          summary: 'Deployment health probe',
          description: 'Reports application version, database connectivity and uptime. No authentication.',
          security: [],
          responses: {
            '200': { description: 'Health snapshot (version, database status, uptime).', content: { 'application/json': { schema: { type: 'object' } } } },
          },
        },
      },
      '/api/public/menu': {
        get: {
          tags: ['guest'],
          summary: 'Public menu for a table (QR) or kiosk device',
          description: `Same DB as the POS. Access via ?qr=<table token> or X-Device-Token (kiosk). Rate limit: ${RL.menu}.`,
          security: [{ QrToken: [] }, { DeviceToken: [] }],
          parameters: [
            { name: 'qr', in: 'query', required: false, schema: { type: 'string' }, description: 'Table QR token (alternative to the device header).' },
          ],
          responses: {
            '200': { description: 'Full guest-visible menu (categories, items, prices, allergens, modifiers).', content: { 'application/json': { schema: { type: 'object' } } } },
            '404': NOT_FOUND_404,
            '429': RATE_429,
          },
        },
      },
      '/api/public/menu/availability': {
        get: {
          tags: ['guest'],
          summary: '86-board availability for guests',
          description: `Availability map of menu items (sold-out board). Access like /api/public/menu. Rate limit: ${RL.menu}.`,
          security: [{ QrToken: [] }, { DeviceToken: [] }],
          responses: {
            '200': { description: 'Availability snapshot.', content: { 'application/json': { schema: { type: 'object' } } } },
            '429': RATE_429,
          },
        },
      },
      '/api/public/orders': {
        post: {
          tags: ['guest'],
          summary: 'Submit a guest order (QR self-order or kiosk)',
          description:
            'Enters the SAME canonical order pipeline as the POS ' +
            '(createOrderCore → Order → OrderItem → KDS → Payment → FURS). locationId/tableId and ' +
            `prices are ALWAYS resolved server-side from the token. Idempotent via clientOperationId. Rate limit: ${RL.order}.`,
          security: [{ QrToken: [] }, { DeviceToken: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['items'],
                  properties: {
                    qrToken: { type: 'string', description: 'Table QR token (alternative to the device header).' },
                    items: { type: 'array', minItems: 1, items: { type: 'object', properties: { menuItemId: { type: 'string' }, quantity: { type: 'integer', minimum: 1 }, note: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } } } } },
                    clientOperationId: { type: 'string', description: 'Client idempotency key — retries never duplicate the order.' },
                    note: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Order created (canonical order data, guest-visible status).', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': BAD_400,
            '401': { description: 'Kiosk device unknown or not alive.' },
            '404': NOT_FOUND_404,
            '429': RATE_429,
          },
        },
      },
      '/api/public/orders/status': {
        get: {
          tags: ['guest'],
          summary: 'Guest-visible order status (QR)',
          description: `Status page backend for the guest (only GUEST_VISIBLE_ORDER_STATUS values are exposed). Rate limit: ${RL.status}.`,
          security: [{ QrToken: [] }],
          parameters: [
            { name: 'qr', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'orderNumber', in: 'query', required: true, schema: { type: 'integer' } },
          ],
          responses: {
            '200': { description: 'Guest-visible order status.', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': BAD_400,
            '404': NOT_FOUND_404,
            '429': RATE_429,
          },
        },
      },
      '/api/public/pay/{token}': {
        get: {
          tags: ['paylink'],
          summary: 'Pay link status and bill preview',
          description: 'Returns the outstanding bill for the pay link token (guest-facing payment page backend).',
          security: [{ PayLinkToken: [] }],
          parameters: [
            { name: 'token', in: 'path', required: true, schema: { type: 'string' }, description: 'Pay link token (32-hex).' },
          ],
          responses: {
            '200': { description: 'Pay link state (bill, session status).', content: { 'application/json': { schema: { type: 'object' } } } },
            '404': NOT_FOUND_404,
            '429': RATE_429,
          },
        },
        post: {
          tags: ['paylink'],
          summary: 'Pay link action (open/expire Stripe session)',
          description: 'Opens or expires the Stripe Checkout session behind the pay link.',
          security: [{ PayLinkToken: [] }],
          parameters: [
            { name: 'token', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Action result (session URL or state).', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': BAD_400,
            '404': NOT_FOUND_404,
            '429': RATE_429,
          },
        },
      },
      '/api/public/reservations': {
        get: {
          tags: ['reservations'],
          summary: 'Reservation widget board',
          description: `Public reservation widget (/r/<token>): slot grid + availability for a date. Rate limit: ${RL.menu}.`,
          security: [{ PortalToken: [] }],
          parameters: [
            { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'date', in: 'query', required: false, schema: { type: 'string', format: 'date' } },
          ],
          responses: {
            '200': { description: 'Widget policy + slot grid.', content: { 'application/json': { schema: { type: 'object' } } } },
            '404': NOT_FOUND_404,
            '429': RATE_429,
          },
        },
        post: {
          tags: ['reservations'],
          summary: 'Create a public reservation',
          description: 'Creates a reservation from the widget (capacity-locked server-side).',
          security: [{ PortalToken: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token'],
                  properties: {
                    token: { type: 'string' },
                    date: { type: 'string', format: 'date' },
                    slot: { type: 'string', description: 'Chosen slot (from the board).' },
                    name: { type: 'string' },
                    phone: { type: 'string' },
                    guests: { type: 'integer', minimum: 1 },
                    note: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Reservation created.', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': BAD_400,
            '404': NOT_FOUND_404,
            '429': RATE_429,
          },
        },
      },
      '/api/public/feedback': {
        post: {
          tags: ['feedback'],
          summary: 'Guest feedback submission (QR)',
          description: `Overall/food/service/atmosphere ratings from the table QR. locationId/tableId resolved SERVER-side from the token. Rate limit: ${RL.feedback}.`,
          security: [{ QrToken: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token', 'overallRating'],
                  properties: {
                    token: { type: 'string', description: 'Table QR token.' },
                    overallRating: { type: 'integer', minimum: 1, maximum: 5 },
                    foodRating: { type: 'integer', minimum: 1, maximum: 5 },
                    serviceRating: { type: 'integer', minimum: 1, maximum: 5 },
                    atmosphereRating: { type: 'integer', minimum: 1, maximum: 5 },
                    comment: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Feedback stored.', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': BAD_400,
            '404': NOT_FOUND_404,
            '429': RATE_429,
          },
        },
      },
      '/api/public/crm/unsubscribe': {
        get: {
          tags: ['crm'],
          summary: 'One-click unsubscribe page',
          description: `One-click opt-out from marketing sends (token from the message footer). Returns a friendly HTML page. Rate limit: ${RL.label}.`,
          security: [{ PortalToken: [] }],
          parameters: [
            { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'lang', in: 'query', required: false, schema: { type: 'string', enum: ['sl', 'hr', 'en'] } },
          ],
          responses: {
            '200': { description: 'HTML confirmation page.' },
            '404': NOT_FOUND_404,
            '429': RATE_429,
          },
        },
        post: {
          tags: ['crm'],
          summary: 'Unsubscribe confirmation',
          description: 'Confirms the opt-out for the token (idempotent).',
          security: [{ PortalToken: [] }],
          responses: {
            '200': { description: 'HTML confirmation page (idempotent).' },
            '404': NOT_FOUND_404,
            '429': RATE_429,
          },
        },
      },
      '/api/public/label-status': {
        get: {
          tags: ['labels'],
          summary: 'Production label status (QR on label)',
          description: `Status backend for the QR printed on production labels (/label/<token>). Wrong/unknown token → generic 404 (no existence leak). Rate limit: ${RL.label}.`,
          security: [{ PortalToken: [] }],
          parameters: [
            { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Label status snapshot.', content: { 'application/json': { schema: { type: 'object' } } } },
            '404': NOT_FOUND_404,
            '429': RATE_429,
          },
        },
      },
      '/api/public/stripe/webhook': {
        post: {
          tags: ['stripe'],
          summary: 'Stripe webhook receiver',
          description: 'Receives Stripe payment events (signature REQUIRED and verified against the configured webhook secret).',
          security: [{ StripeSignature: [] }],
          responses: {
            '200': { description: 'Event accepted.' },
            '400': BAD_400,
          },
        },
      },
      '/api/public/web-portal': {
        get: {
          tags: ['web-portal'],
          summary: 'Web portal menu and policy',
          description: `Own web ordering portal (/s/<token>): menu + portal policy (open/closed, modes, fees). Rate limit: ${RL.menu}.`,
          security: [{ PortalToken: [] }],
          parameters: [
            { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Portal menu + policy.', content: { 'application/json': { schema: { type: 'object' } } } },
            '404': NOT_FOUND_404,
            '429': RATE_429,
          },
        },
        post: {
          tags: ['web-portal'],
          summary: 'Submit a web portal order',
          description: 'Enters the same canonical order pipeline as the POS; pickup/delivery per portal policy.',
          security: [{ PortalToken: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token', 'items'],
                  properties: {
                    token: { type: 'string' },
                    items: { type: 'array', minItems: 1, items: { type: 'object', properties: { menuItemId: { type: 'string' }, quantity: { type: 'integer', minimum: 1 }, note: { type: 'string' } } } },
                    customerName: { type: 'string' },
                    customerPhone: { type: 'string' },
                    fulfillment: { type: 'string', description: 'Pickup or delivery (per portal policy).' },
                    clientOperationId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Order created.', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': BAD_400,
            '404': NOT_FOUND_404,
            '429': RATE_429,
          },
        },
      },
      '/api/public/web-portal/status': {
        get: {
          tags: ['web-portal'],
          summary: 'Web portal order status',
          description: 'Guest-visible status of a web portal order (token-scoped).',
          security: [{ PortalToken: [] }],
          parameters: [
            { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Guest-visible status.', content: { 'application/json': { schema: { type: 'object' } } } },
            '404': NOT_FOUND_404,
            '429': RATE_429,
          },
        },
      },
      '/api/sync': {
        get: {
          tags: ['sync'],
          summary: 'Offline queue pull (authenticated staff)',
          description: 'Server state snapshot for the offline POS queue (operations since a cursor). Requires a staff session.',
          security: [{ SessionAuth: [] }],
          responses: {
            '200': { description: 'Snapshot for the offline queue.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Missing or invalid staff session.' },
          },
        },
        post: {
          tags: ['sync'],
          summary: 'Offline queue flush (authenticated staff)',
          description: 'Flushes offline-recorded operations (idempotent via clientOperationId; R2b1/R7 fiscal guarantees preserved).',
          security: [{ SessionAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['operations'],
                  properties: {
                    operations: { type: 'array', minItems: 1, items: { type: 'object', properties: { clientOperationId: { type: 'string' }, kind: { type: 'string' }, payload: { type: 'object' } } } },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Flush result (applied/duplicated/failed per operation).', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': BAD_400,
            '401': { description: 'Missing or invalid staff session.' },
          },
        },
      },
    },
  }
}
