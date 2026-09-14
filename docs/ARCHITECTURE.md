# OrderFlow Architecture and Saga Flows

This document maps the architecture and flows implemented by the current code. The diagrams are **as-built**, not proposed future behavior.

## 1. System architecture

OrderFlow is an event-driven system with three independently runnable services. Clients use HTTP; the checkout workflow crosses service boundaries through RabbitMQ events.

```mermaid
flowchart LR
    Client[Client]
    Exchange{{RabbitMQ<br/>orderflow.events}}

    subgraph Order[Order Service :3001]
        OAPI[Order HTTP API]
        Relay[Outbox relay]
        OC[Order consumer]
    end

    subgraph Inventory[Inventory Service :3002]
        IAPI[Product HTTP API]
        IC[Inventory consumer]
        Cache[Cache-aside adapter]
    end

    subgraph Payment[Payment Service :3003]
        PAPI[Payment audit API]
        PC[Payment consumer]
    end

    ODB[(Order PostgreSQL)]
    IDB[(Inventory PostgreSQL)]
    PDB[(Payment PostgreSQL)]
    Redis[(Redis)]

    Client -->|POST /api/orders| OAPI
    Client -->|GET order| OAPI
    Client -->|GET products| IAPI
    Client -->|GET payment| PAPI

    OAPI -->|Order + items + outbox<br/>one transaction| ODB
    ODB --> Relay
    Relay -->|order.ordercreated| Exchange

    Exchange -->|order.ordercreated| IC
    IC --> IDB
    IC -->|inventory events| Exchange

    Exchange -->|inventory.reserved| PC
    PC --> PDB
    PC -->|payment outcome| Exchange

    Exchange -->|payment outcome or inventory failure| OC
    OC --> ODB
    Exchange -->|payment outcome| IC

    IAPI --> Cache
    Cache <--> Redis
    Cache -->|miss| IDB
    IC -->|invalidate changed products| Redis
```

### Service ownership

| Service | Responsibility | Owned models | Background processes |
| --- | --- | --- | --- |
| Order | Accept orders and own final order state | `Order`, `OrderItem`, `OutboxEvent`, `ProcessedEvent` | Outbox relay and order-outcome consumer |
| Inventory | Own products, stock, and reservations | `Product`, `InventoryReservation`, `ProcessedEvent` | Reservation/commit/release consumer |
| Payment | Process and audit payment attempts | `Payment`, `ProcessedEvent` | Payment consumer |

There are no database foreign keys between services. IDs cross boundaries only through event payloads. Internally, each service approximately follows:

```text
app.js -> HTTP controller or RabbitMQ consumer -> service -> Prisma / Redis
```

This is pragmatic layering, not strict Clean Architecture: concrete infrastructure is imported directly and no repository interfaces or dependency-injection container are present.

## 2. RabbitMQ topology and event contracts

```mermaid
flowchart LR
    X{{orderflow.events<br/>topic exchange}}
    IQ[[inventory_service_queue]]
    PQ[[payment_service_queue]]
    OQ[[order_service_queue]]
    I[Inventory consumer]
    P[Payment consumer]
    O[Order consumer]
    DLX{{orderflow.dlx}}
    DLQ[(orderflow.dlq)]

    X -->|order.ordercreated| IQ --> I
    X -->|inventory.reserved| PQ --> P
    X -->|inventory.reservation_failed| OQ
    X -->|payment.succeeded| OQ
    X -->|payment.failed| OQ
    OQ --> O
    X -->|payment.succeeded| IQ
    X -->|payment.failed| IQ

    IQ -. rejected .-> DLX
    PQ -. rejected .-> DLX
    OQ -. rejected .-> DLX
    DLX -->|dead-letter| DLQ
```

| Routing key | Publisher | Consumer(s) | Payload used by the code |
| --- | --- | --- | --- |
| `order.ordercreated` | Order relay | Inventory | `{ orderId, userId, totalAmount, items[] }` |
| `inventory.reserved` | Inventory | Payment | `{ orderId, totalAmount, status: "RESERVED" }` |
| `inventory.reservation_failed` | Inventory | Order | `{ orderId, reason }` |
| `payment.succeeded` | Payment | Order, Inventory | `{ orderId, paymentId, amount, status: "SUCCEEDED" }` |
| `payment.failed` | Payment | Order, Inventory | `{ orderId, reason, status: "FAILED" }` |
| `inventory.released` | Inventory | No in-repository consumer | `{ orderId, status: "RELEASED" }` |

Messages are persistent JSON. AMQP metadata carries `messageId`, `correlationId`, and `eventType`; Inventory outputs also carry `parentEventId`. There is no shared versioned event schema.

## 3. State transitions

### Order

```mermaid
stateDiagram-v2
    [*] --> PENDING: POST /api/orders
    PENDING --> CONFIRMED: payment.succeeded
    PENDING --> FAILED: payment.failed
    PENDING --> FAILED: inventory.reservation_failed
    CONFIRMED --> [*]
    FAILED --> [*]
```

`CANCELLED` exists in the schema but is not used by a current transition.

### Inventory reservation

```mermaid
stateDiagram-v2
    [*] --> RESERVED: reservation succeeds
    RESERVED --> COMMITTED: payment.succeeded
    RESERVED --> RELEASED: payment.failed
    COMMITTED --> [*]
    RELEASED --> [*]
```

### Payment

```mermaid
stateDiagram-v2
    [*] --> SUCCEEDED: amount up to 5000
    [*] --> FAILED: amount above 5000
```

`REFUNDED` exists in the schema, but refund processing is not implemented.

## 4. Successful Saga flow

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant O as Order Service
    participant ODB as Order DB
    participant MQ as RabbitMQ
    participant I as Inventory Service
    participant IDB as Inventory DB
    participant P as Payment Service
    participant PDB as Payment DB

    Client->>O: POST /api/orders
    O->>ODB: TX: PENDING order + items + PENDING outbox event
    O-->>Client: 202 Accepted + orderId

    Note over O,MQ: Outbox relay polls every second
    O->>MQ: order.ordercreated
    O->>ODB: Mark outbox PUBLISHED

    MQ->>I: order.ordercreated
    I->>IDB: Check ProcessedEvent
    I->>IDB: TX: atomically reserve every item
    I->>MQ: inventory.reserved
    I->>IDB: Insert ProcessedEvent
    I-->>MQ: ACK

    MQ->>P: inventory.reserved
    P->>PDB: Check ProcessedEvent
    P->>PDB: Create SUCCEEDED payment
    P->>MQ: payment.succeeded
    P->>PDB: Insert ProcessedEvent
    P-->>MQ: ACK

    par Finalize order
        MQ->>O: payment.succeeded
        O->>ODB: TX: CONFIRMED + ProcessedEvent
        O-->>MQ: ACK
    and Commit stock
        MQ->>I: payment.succeeded
        I->>IDB: TX: reduce totals + mark COMMITTED
        I-->>MQ: ACK
    end

    Client->>O: GET /api/orders/:id
    O-->>Client: CONFIRMED
```

Order confirmation and inventory commit run independently, so temporary disagreement is possible under eventual consistency.

## 5. Inventory-failure flow

All requested items reserve within one local transaction. If one conditional update finds insufficient stock, the entire transaction rolls back.

```mermaid
sequenceDiagram
    autonumber
    participant MQ as RabbitMQ
    participant I as Inventory Service
    participant IDB as Inventory DB
    participant O as Order Service
    participant ODB as Order DB

    MQ->>I: order.ordercreated
    I->>IDB: Begin reservation transaction
    loop Each item
        I->>IDB: UPDATE where available stock >= quantity
    end
    IDB-->>I: One update returns no row
    I->>IDB: Roll back all reservations
    I->>I: Log INSUFFICIENT_STOCK
    I->>MQ: inventory.reservation_failed
    I->>IDB: Insert ProcessedEvent
    I-->>MQ: ACK original event

    MQ->>O: inventory.reservation_failed
    O->>ODB: TX: FAILED + reason + ProcessedEvent
    O-->>MQ: ACK
```

This is an expected business failure and does not go to the DLQ.

## 6. Payment-failure compensation flow

The mock payment fails when the total is greater than `5000`. Inventory then runs the implemented compensating action, `releaseStock()`.

```mermaid
sequenceDiagram
    autonumber
    participant MQ as RabbitMQ
    participant P as Payment Service
    participant PDB as Payment DB
    participant O as Order Service
    participant ODB as Order DB
    participant I as Inventory Service
    participant IDB as Inventory DB
    participant Redis as Redis

    MQ->>P: inventory.reserved
    P->>PDB: Create FAILED payment + reason
    P->>P: Log card decline
    P->>MQ: payment.failed
    P-->>MQ: ACK

    par Fail order
        MQ->>O: payment.failed
        O->>ODB: TX: FAILED + reason + ProcessedEvent
        O-->>MQ: ACK
    and Compensate inventory
        MQ->>I: payment.failed
        I->>IDB: Load RESERVED rows
        I->>IDB: TX: reduce stock_reserved
        I->>IDB: Mark reservations RELEASED
        I->>Redis: Invalidate product keys
        I->>MQ: inventory.released
        I-->>MQ: ACK
    end
```

The compensation restores availability by reducing `stock_reserved`; it does not reduce `stock_total`.

## 7. Transactional outbox flow

```mermaid
flowchart TD
    Request[POST /api/orders]
    Tx[Begin Prisma transaction]
    Order[Insert Order and OrderItems]
    Event[Insert PENDING OutboxEvent]
    Commit{Commit succeeds?}
    Accepted[Return 202 PENDING]
    Poll[Relay loads up to 20 PENDING events]
    Publish[Publish order.ordercreated]
    Buffered{publish returned true?}
    Done[Mark PUBLISHED]
    Later[Leave PENDING for next poll]
    Error[Log relay error]

    Request --> Tx --> Order --> Event --> Commit
    Commit -->|yes| Accepted --> Poll --> Publish --> Buffered
    Commit -->|no| Error
    Buffered -->|yes| Done
    Buffered -->|no| Later
    Publish -. exception .-> Error
```

The Order and first outbox record commit atomically. The relay does not use publisher confirms: `publish() === true` means the local buffer accepted the message, not that RabbitMQ persisted it.

## 8. Consumer error, trace, and DLQ flow

```mermaid
flowchart TD
    Receive[Receive message]
    Context[Read messageId, routingKey, correlationId]
    Seen{ProcessedEvent exists?}
    Duplicate[Log duplicate and ACK]
    Work[Run business operation]
    Record[Insert ProcessedEvent]
    Ack[ACK]
    Error[Log error with eventId]
    Nack[NACK requeue=false]
    DLX[orderflow.dlx]
    DLQ[orderflow.dlq]

    Receive --> Context --> Seen
    Seen -->|yes| Duplicate
    Seen -->|no| Work --> Record --> Ack
    Context -. exception .-> Error
    Work -. exception .-> Error
    Record -. exception .-> Error
    Error --> Nack --> DLX --> DLQ
```

| Failure type | Current behavior |
| --- | --- |
| Insufficient stock | Log warning, emit `inventory.reservation_failed`, ACK |
| Mock card decline | Store/log failure, emit `payment.failed`, ACK |
| Unexpected consumer exception | Log error, NACK, dead-letter |
| Redis GET error | Log error and fall back to PostgreSQL |
| Redis SET/DEL error | Log error and continue |

Order combines its state update and `ProcessedEvent` insert in one transaction. Inventory and Payment perform business work and publish before recording `ProcessedEvent`, leaving crash/duplicate windows.

## 9. Product cache flow

Only `GET /api/products/:id` uses Redis; `GET /api/products` reads PostgreSQL directly.

```mermaid
flowchart TD
    Request[GET /api/products/:id]
    Get[Redis GET product:productId]
    Hit{Hit?}
    Cached[Parse and return cached JSON]
    DB[Query PostgreSQL]
    Exists{Found?}
    Missing[Return 404]
    Calculate[Calculate stockAvailable]
    Set[Redis SETEX 300 seconds]
    Return[Return product]

    Request --> Get --> Hit
    Hit -->|yes| Cached
    Hit -->|no or Redis error| DB --> Exists
    Exists -->|no| Missing
    Exists -->|yes| Calculate --> Set --> Return
```

Reservation, commit, and release operations invalidate affected product keys.

## 10. Safe startup flow

Queues and bindings are created during service startup. Start consumers before Order can publish:

```mermaid
sequenceDiagram
    participant Infra as PostgreSQL / RabbitMQ / Redis
    participant P as Payment
    participant I as Inventory
    participant O as Order
    actor Client

    P->>Infra: Declare payment queue and binding
    P->>P: Start consumer and HTTP
    I->>Infra: Declare inventory queue and bindings
    I->>I: Start consumer and HTTP
    O->>Infra: Declare order queue and bindings
    O->>O: Start relay, consumer, and HTTP
    Client->>O: Submit order after all services are ready
```

Recommended order: **Payment → Inventory → Order**.

## 11. Reliability boundaries

| Boundary | Implemented guarantee | Remaining gap |
| --- | --- | --- |
| Order creation | Order, items, and outbox record are atomic | Broker delivery is not confirmed |
| Inventory reservation | All items reserve or all roll back | Outcome publication is outside the transaction |
| Payment | Unique payment per `orderId` | Payment write and event publication are not atomic |
| Order outcome | Status and processed marker are atomic | Order can confirm before inventory commit |
| Technical error | Logged and dead-lettered | No retry/backoff stage |
| Post-payment inventory failure | Inventory event enters DLQ | No payment refund/order reversal |
| Abandoned reservation | Reservation remains stored | No expiry/reaper |
| Traceability | Correlation ID propagates in headers | Some error logs omit correlation/order IDs |

## 12. Code map

| Behavior | Source |
| --- | --- |
| Correlation-ID middleware | [`order-service/src/app.js`](../order-service/src/app.js#L21-L30) |
| Order request and `202` | [`orderController.js`](../order-service/src/controllers/orderController.js#L7-L45) |
| Order/outbox transaction | [`orderService.js`](../order-service/src/services/orderService.js#L8-L56) |
| Outbox relay | [`outboxRelay.js`](../order-service/src/workers/outboxRelay.js#L24-L83) |
| Order outcome handler | [`orderConsumer.js`](../order-service/src/consumers/orderConsumer.js#L24-L71) |
| RabbitMQ order bindings | [`rabbitmq.js`](../order-service/src/config/rabbitmq.js#L18-L38) |
| Atomic reservation | [`inventoryService.js`](../inventory-service/src/services/inventoryService.js#L12-L59) |
| Release compensation | [`inventoryService.js`](../inventory-service/src/services/inventoryService.js#L66-L101) |
| Commit stock | [`inventoryService.js`](../inventory-service/src/services/inventoryService.js#L108-L137) |
| Inventory event routing | [`inventoryConsumer.js`](../inventory-service/src/consumers/inventoryConsumer.js#L25-L92) |
| Cache-aside | [`productCache.js`](../inventory-service/src/cache/productCache.js#L4-L47) |
| Payment decision | [`paymentService.js`](../payment-service/src/services/paymentService.js#L13-L47) |
| Payment event flow | [`paymentConsumer.js`](../payment-service/src/consumers/paymentConsumer.js#L26-L79) |

## One-line mental model

```text
HTTP creates PENDING Order + Outbox
  -> Inventory reserves
  -> Payment decides
  -> success confirms Order and commits Inventory
  -> failure fails Order and releases Inventory
  -> unexpected consumer errors go to the DLQ
```
