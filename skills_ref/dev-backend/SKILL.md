---
name: dev-backend
description: "Backend development guide for orchestrated sub-agents. Framework-agnostic API design, architecture patterns, database optimization, error handling, security, and logging. Injected when role=backend."
---

# Dev-Backend — Backend Development Guide

Backend architecture patterns and best practices for building reliable server-side applications.

## When to Activate

- Designing REST or GraphQL API endpoints
- Implementing service, controller, or repository layers
- Optimizing database queries (N+1, indexing, connection pooling)
- Adding authentication, authorization, or rate limiting
- Structuring error handling and validation
- Building middleware (logging, auth, CORS)

---

## 1. API Design Patterns

### RESTful Conventions

| Method | Purpose | Idempotent | Example |
|--------|---------|------------|---------|
| GET | Read (list or single) | Yes | `GET /api/users`, `GET /api/users/:id` |
| POST | Create new resource | No | `POST /api/users` |
| PUT | Full replace | Yes | `PUT /api/users/:id` |
| PATCH | Partial update | Yes | `PATCH /api/users/:id` |
| DELETE | Remove resource | Yes | `DELETE /api/users/:id` |

### Consistent Response Format

Every endpoint must use the same response envelope:

```json
// Success
{
  "success": true,
  "data": { "id": 1, "name": "John" },
  "meta": { "requestId": "abc-123" }
}

// Error
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid email format",
    "details": [{ "field": "email", "message": "must be a valid email" }]
  },
  "meta": { "requestId": "abc-123" }
}
```

### HTTP Status Codes

| Code | When to Use |
|------|-------------|
| 200 | Success (GET, PUT, PATCH) |
| 201 | Created (POST) |
| 204 | No Content (DELETE) |
| 400 | Validation error, malformed request |
| 401 | Authentication required |
| 403 | Authenticated but not authorized |
| 404 | Resource not found |
| 409 | Conflict (duplicate, version mismatch) |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

### Pagination

For list endpoints, support cursor-based or offset pagination:

```
GET /api/users?limit=20&offset=0&sort=name&order=asc
GET /api/users?limit=20&cursor=abc123
```

Return pagination metadata in the response:

```json
{
  "data": [...],
  "meta": { "total": 142, "limit": 20, "offset": 0, "hasMore": true }
}
```

---

## 2. Architecture Patterns

### Layered Architecture

```
Routes → Controllers → Services → Repositories → Database
  │          │             │            │
  │          │             │            └── Data access only (SQL, ORM calls)
  │          │             └── Business logic, validation rules
  │          └── Parse HTTP input, format HTTP output
  └── URL mapping, middleware chain
```

**Rules:**
- **Routes** only define URL patterns and attach middleware. No logic.
- **Controllers** parse `req.body`/`req.params`, call services, format `res.json()`. Never contain business rules.
- **Services** receive plain data objects (not `req`/`res`). Return plain data. All business logic lives here.
- **Repositories** abstract database access. Services never write raw SQL.

### When to Split

| Signal | Action |
|--------|--------|
| Module needs different scaling (e.g., image processing vs API) | Extract to separate service |
| Separate team needs independent deployment | Extract to microservice |
| Technology mismatch (e.g., Python ML + Node API) | Separate service per technology |
| File >1000 lines in a single layer | Split by domain within the same layer |
| **Everything else** | Keep in monolith. Don't microservice prematurely. |

**Default to monolith** for teams of <10 developers. Extract only when you have a clear, proven need.

---

## 3. Database Patterns

### Query Optimization

```sql
-- ✅ Select only needed columns
SELECT id, name, email FROM users WHERE role = 'admin' LIMIT 20;

-- ❌ Never SELECT * in production queries
SELECT * FROM users;
```

### N+1 Prevention

```
❌ BAD (N+1):
  users = fetchUsers()          -- 1 query
  for user in users:
    orders = fetchOrders(user.id) -- N queries

✅ GOOD (batch):
  users = fetchUsers()                    -- 1 query
  userIds = users.map(u => u.id)
  orders = fetchOrdersByUserIds(userIds)  -- 1 query
  ordersMap = groupBy(orders, 'userId')
  -- Total: 2 queries regardless of N
```

### Index Strategy

| Type | Use Case | Example |
|------|----------|---------|
| Single column | Equality lookups | `CREATE INDEX idx_users_email ON users(email)` |
| Composite | Multi-column WHERE | `CREATE INDEX idx_orders_user_status ON orders(user_id, status)` |
| Partial | Filtered subsets | `CREATE INDEX idx_active ON orders(created_at) WHERE status = 'active'` |
| Covering | Avoid table lookups | `CREATE INDEX idx_email_name ON users(email) INCLUDE (name)` |

**Rule of thumb:** If a WHERE clause column appears in slow queries, it probably needs an index.

### Transactions

Wrap multi-step writes in a single transaction. If any step fails, all changes roll back.

- Use the framework's transaction API — never manual `BEGIN`/`COMMIT`.
- Keep transactions short. Don't do network calls inside a transaction.
- Deadlock prevention: always acquire locks in the same order.

### Migrations

- One migration file per schema change, timestamped.
- Always include a rollback (reverse migration).
- Never modify a migration that has already been applied in any environment.
- Test migrations on a copy of production data before deploying.

---

## 4. Error Handling

### Error Classification

| Type | Example | Response | Log Level |
|------|---------|----------|-----------|
| **Validation error** | Missing required field | 400 + details | warn |
| **Authentication error** | Invalid/expired token | 401 | warn |
| **Authorization error** | Insufficient permissions | 403 | warn |
| **Not found** | Resource doesn't exist | 404 | info |
| **Conflict** | Duplicate entry | 409 | warn |
| **Rate limit** | Too many requests | 429 + Retry-After | info |
| **Internal error** | Unhandled exception, DB failure | 500 | error + stack trace |

### Centralized Error Handler

Define a custom error class to distinguish operational from programmer errors:

```
class AppError extends Error {
  constructor(code, message, statusCode, details)
}

// Operational: user did something wrong → return HTTP error
throw new AppError('VALIDATION_ERROR', 'Email is required', 400);

// Programmer: code has a bug → return 500, log full stack
// (unhandled exceptions caught by global handler)
```

### Retry with Exponential Backoff

For transient failures (network timeouts, rate limits, database locks):

| Attempt | Wait |
|---------|------|
| 1 | 0s (immediate) |
| 2 | 1s |
| 3 | 2s |
| 4 | 4s |
| Max | 3-5 attempts depending on operation |

Never retry non-idempotent operations (POST) without deduplication.

---

## 5. Security

### Input Validation

- Validate ALL user input at the API boundary using schema validation (Zod, Joi, JSON Schema, etc.).
- Reject unknown fields. Coerce types explicitly. Enforce length, range, and format limits.
- Never trust client-side validation — always re-validate server-side.

### Authentication

- Use short-lived access tokens (15-60 min) + longer-lived refresh tokens.
- Store secrets in environment variables, never in source code.
- Verify tokens on every protected endpoint via middleware.
- Hash passwords with bcrypt/argon2 (cost factor ≥10).

### Authorization

- Define permission roles clearly: `read`, `write`, `delete`, `admin`.
- Check permissions in middleware, not inside business logic.
- Default to deny — explicitly grant access, never rely on "not forbidden."

### Rate Limiting

- Apply per-IP and per-user limits on all public endpoints.
- Return `429 Too Many Requests` with `Retry-After` header.
- Tighter limits on sensitive endpoints (login, password reset).

### Security Headers

Enable at minimum:
- `Strict-Transport-Security` (HSTS)
- `Content-Security-Policy`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- Disable `X-Powered-By`
- Configure CORS explicitly — never use `*` in production.

---

## 6. Logging & Middleware

### Structured Logging

Log as JSON with consistent fields for machine parseability:

```json
{
  "timestamp": "2025-01-15T10:30:00Z",
  "level": "info",
  "message": "Request completed",
  "requestId": "req-abc-123",
  "method": "POST",
  "path": "/api/users",
  "statusCode": 201,
  "duration": 45,
  "userId": "user-456"
}
```

**Log levels:**
| Level | When |
|-------|------|
| `error` | Unhandled exceptions, data corruption, service down |
| `warn` | Validation failures, deprecated usage, retry attempts |
| `info` | Request start/end, significant state changes |
| `debug` | Detailed flow for development (disable in production) |

### Middleware Execution Order

Order matters. Apply in this sequence:

1. **Request ID** — Generate unique ID for tracing
2. **Request logging** — Log method, path, start time
3. **Security headers** — CORS, CSP, HSTS
4. **Rate limiting** — Block excessive requests early
5. **Authentication** — Verify identity
6. **Authorization** — Check permissions
7. **Body parsing** — Parse JSON/form data
8. **Input validation** — Validate against schema
9. **Route handler** — Business logic
10. **Error handler** — Catch and format errors
11. **Response logging** — Log status code, duration
