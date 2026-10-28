-- ============================================================================
-- হিসাবখাতা (HisabKhata) - Database Schema (Cloudflare D1 / SQLite)
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- 1. AUTHENTICATION, SESSIONS, SECURITY & SYNC IDEMPOTENCY
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,                       -- SHA-256 of session token
    user_id TEXT NOT NULL,
    user_agent TEXT,
    ip_address TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT PRIMARY KEY,                      -- "ip:...", "user:...", "setup:..."
    attempt_count INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    details TEXT,
    ip_address TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS sync_ops (
    op_id TEXT PRIMARY KEY,                    -- Client-generated UUID for idempotency
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- ----------------------------------------------------------------------------
-- 2. ACCOUNTS & CAPITAL
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,                       -- UUID
    name TEXT NOT NULL,                        -- Cash, bKash, Nagad, Bank, etc.
    type TEXT NOT NULL,                        -- 'cash', 'mobile_banking', 'bank', 'other'
    account_number TEXT,
    opening_balance REAL NOT NULL DEFAULT 0.0,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS capital_entries (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,                        -- 'investment', 'withdrawal'
    amount REAL NOT NULL,
    account_id TEXT NOT NULL,
    note TEXT,
    date TEXT NOT NULL,                        -- YYYY-MM-DD
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS account_transfers (
    id TEXT PRIMARY KEY,
    from_account_id TEXT NOT NULL,
    to_account_id TEXT NOT NULL,
    amount REAL NOT NULL,
    fee REAL NOT NULL DEFAULT 0.0,             -- e.g. bKash cashout fee
    note TEXT,
    date TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (from_account_id) REFERENCES accounts(id),
    FOREIGN KEY (to_account_id) REFERENCES accounts(id)
);

-- ----------------------------------------------------------------------------
-- 3. CONTACTS (SUPPLIERS & CUSTOMERS)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    note TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    note TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- ----------------------------------------------------------------------------
-- 4. PRODUCTS & VARIANTS
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    unit TEXT NOT NULL DEFAULT 'pc',           -- pc, kg, pack, etc.
    description TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS product_variants (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    sku TEXT,
    color TEXT,
    size TEXT,
    default_buy_price REAL NOT NULL DEFAULT 0.0,
    default_sell_price REAL NOT NULL DEFAULT 0.0,
    low_stock_threshold INTEGER NOT NULL DEFAULT 5,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_variant_product ON product_variants(product_id);

-- ----------------------------------------------------------------------------
-- 5. PURCHASES & EXPENSES
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS purchases (
    id TEXT PRIMARY KEY,
    supplier_id TEXT,
    account_id TEXT NOT NULL,
    purchase_date TEXT NOT NULL,
    subtotal REAL NOT NULL DEFAULT 0.0,
    extra_costs REAL NOT NULL DEFAULT 0.0,     -- Freight/labour distributed across items
    total_cost REAL NOT NULL DEFAULT 0.0,      -- subtotal + extra_costs
    amount_paid REAL NOT NULL DEFAULT 0.0,
    due_amount REAL NOT NULL DEFAULT 0.0,
    note TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS purchase_items (
    id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    quantity REAL NOT NULL,
    raw_unit_cost REAL NOT NULL,               -- Invoice cost per piece
    landed_unit_cost REAL NOT NULL,            -- Cost per piece including allocated extra_costs
    total_amount REAL NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id) REFERENCES product_variants(id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);

CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,                    -- rent, packaging, transport, ads, salary, utilities, cashout, other
    amount REAL NOT NULL,
    account_id TEXT NOT NULL,
    expense_date TEXT NOT NULL,
    note TEXT,
    is_recurring INTEGER NOT NULL DEFAULT 0,   -- Monthly recurring flag
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);

-- ----------------------------------------------------------------------------
-- 6. SALES, PAYMENTS & RETURNS
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY,
    invoice_no TEXT NOT NULL,
    customer_id TEXT,
    sale_date TEXT NOT NULL,
    subtotal REAL NOT NULL DEFAULT 0.0,
    discount REAL NOT NULL DEFAULT 0.0,
    delivery_charge_customer REAL NOT NULL DEFAULT 0.0, -- Charged to customer
    actual_courier_cost REAL NOT NULL DEFAULT 0.0,      -- Paid by shop owner
    net_payable REAL NOT NULL DEFAULT 0.0,             -- subtotal - discount + delivery_charge_customer
    account_id TEXT,                                   -- Payment account (if amount_received > 0)
    amount_received REAL NOT NULL DEFAULT 0.0,
    due_amount REAL NOT NULL DEFAULT 0.0,              -- net_payable - amount_received
    fee_incurred REAL NOT NULL DEFAULT 0.0,            -- Cashout/gateway fee incurred
    status TEXT NOT NULL DEFAULT 'delivered',          -- 'pending', 'delivered', 'returned', 'cancelled'
    source TEXT NOT NULL DEFAULT 'shop',               -- 'shop', 'facebook', 'website', 'phone'
    note TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_sales_invoice_no ON sales(invoice_no);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);

CREATE TABLE IF NOT EXISTS sale_items (
    id TEXT PRIMARY KEY,
    sale_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit_price REAL NOT NULL,                          -- Selling price
    unit_cogs REAL NOT NULL,                           -- Snapshot of weighted-average cost at moment of sale
    total_price REAL NOT NULL,                         -- quantity * unit_price
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id) REFERENCES product_variants(id)
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

CREATE TABLE IF NOT EXISTS due_payments (
    id TEXT PRIMARY KEY,
    customer_id TEXT,
    supplier_id TEXT,
    sale_id TEXT,
    purchase_id TEXT,
    account_id TEXT NOT NULL,
    type TEXT NOT NULL,                                -- 'customer_receipt' or 'supplier_payment'
    amount REAL NOT NULL,
    payment_date TEXT NOT NULL,
    note TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS returns (
    id TEXT PRIMARY KEY,
    sale_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    quantity REAL NOT NULL,
    refund_amount REAL NOT NULL DEFAULT 0.0,
    account_id TEXT,
    return_date TEXT NOT NULL,
    restock INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (sale_id) REFERENCES sales(id),
    FOREIGN KEY (variant_id) REFERENCES product_variants(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- ----------------------------------------------------------------------------
-- 7. STOCK MOVEMENTS LEDGER (Inventory computed exclusively from this ledger)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_movements (
    id TEXT PRIMARY KEY,
    variant_id TEXT NOT NULL,
    movement_type TEXT NOT NULL,                       -- 'purchase', 'sale', 'sale_return', 'damage', 'adjustment'
    quantity REAL NOT NULL,                            -- Positive for in, negative for out
    unit_cost REAL NOT NULL DEFAULT 0.0,               -- Unit landed cost for moving weighted average
    reference_id TEXT,                                 -- purchase_id, sale_id, return_id, etc.
    movement_date TEXT NOT NULL,
    note TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (variant_id) REFERENCES product_variants(id)
);

CREATE INDEX IF NOT EXISTS idx_stock_variant ON stock_movements(variant_id);
CREATE INDEX IF NOT EXISTS idx_stock_date ON stock_movements(movement_date);
