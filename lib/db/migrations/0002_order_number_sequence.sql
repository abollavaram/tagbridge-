-- Order numbers come from a sequence rather than from randomness. A random
-- suffix wide enough to look safe still collides at volume, and orders.number
-- is unique — so the failure would be a rejected order at checkout.
CREATE SEQUENCE IF NOT EXISTS order_number_seq AS bigint START WITH 1000 INCREMENT BY 1;
