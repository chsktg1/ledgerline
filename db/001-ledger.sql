CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  kind text NOT NULL DEFAULT 'wallet' CHECK (kind IN ('wallet', 'equity')),
  balance bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'equity' OR balance >= 0)
);
CREATE UNIQUE INDEX one_equity_account ON accounts (kind) WHERE kind = 'equity';
CREATE TABLE transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES accounts(id),
  receiver_id uuid NOT NULL REFERENCES accounts(id),
  amount bigint NOT NULL CHECK (amount > 0 AND amount <= 9007199254740991),
  currency text NOT NULL CHECK (currency = 'USD'),
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'rejected')),
  failure_code text,
  reverse_of uuid REFERENCES transfers(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> receiver_id),
  CHECK ((status = 'rejected') = (failure_code IS NOT NULL))
);
CREATE UNIQUE INDEX one_completed_reversal ON transfers(reverse_of) WHERE status='completed';
CREATE TABLE entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES transfers(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount bigint NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency = 'USD'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, direction)
);
CREATE INDEX entries_account ON entries(account_id);
CREATE INDEX transfers_created ON transfers(created_at DESC, id);
CREATE TABLE reconciliation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  balanced boolean NOT NULL,
  matches boolean NOT NULL,
  total_debits text NOT NULL,
  total_credits text NOT NULL,
  account_count integer NOT NULL,
  mismatches jsonb NOT NULL,
  balances jsonb NOT NULL
);
CREATE FUNCTION immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit records are immutable'; END $$;
CREATE TRIGGER immutable_entries BEFORE UPDATE OR DELETE ON entries FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_transfers BEFORE UPDATE OR DELETE ON transfers FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_reports BEFORE UPDATE OR DELETE ON reconciliation_reports FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION apply_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE accounts SET balance = balance + CASE WHEN NEW.direction = 'credit' THEN NEW.amount ELSE -NEW.amount END
  WHERE id = NEW.account_id AND currency = NEW.currency;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry account currency mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER apply_entry_balance AFTER INSERT ON entries FOR EACH ROW EXECUTE FUNCTION apply_entry();
CREATE FUNCTION check_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t transfers; n integer; d numeric; c numeric; valid integer;
BEGIN
  IF TG_TABLE_NAME = 'transfers' THEN t := NEW;
  ELSE SELECT * INTO t FROM transfers WHERE id = NEW.transfer_id; END IF;
  SELECT count(*), COALESCE(sum(amount) FILTER (WHERE direction='debit'),0),
    COALESCE(sum(amount) FILTER (WHERE direction='credit'),0),
    count(*) FILTER (WHERE currency=t.currency AND amount=t.amount AND
      ((direction='debit' AND account_id=t.sender_id) OR (direction='credit' AND account_id=t.receiver_id)))
    INTO n,d,c,valid FROM entries WHERE transfer_id=t.id;
  IF (t.status='completed' AND (n<>2 OR d<>c OR valid<>2)) OR (t.status='rejected' AND n<>0)
  THEN RAISE EXCEPTION 'Unbalanced or invalid journal for %',t.id; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transfer_balanced AFTER INSERT ON transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal();
CREATE CONSTRAINT TRIGGER entry_balanced AFTER INSERT ON entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal();
