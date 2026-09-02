-- Quote numbers come from a sequence, for the same reason order numbers do:
-- quotes.number is unique, and a random suffix wide enough to feel safe still
-- collides at volume. The failure mode would be an agent run that got all the
-- way to a drafted quote and then threw on the insert.
CREATE SEQUENCE IF NOT EXISTS quote_number_seq AS bigint START WITH 1000 INCREMENT BY 1;
