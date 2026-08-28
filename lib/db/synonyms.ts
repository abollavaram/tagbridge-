/**
 * Seed synonym graph.
 *
 * Stored as (term -> canonical) edges. Expansion is bidirectional at query
 * time: a query hitting either side of an edge picks up the other, and terms
 * sharing a canonical form expand to each other.
 */
export type SynonymKind = 'protocol' | 'vendor' | 'device' | 'concept';

export interface SeedSynonym {
  term: string;
  canonical: string;
  kind: SynonymKind;
}

function group(canonical: string, kind: SynonymKind, terms: string[]): SeedSynonym[] {
  return terms.map((term) => ({ term, canonical, kind }));
}

export const SEED_SYNONYMS: SeedSynonym[] = [
  /* vendors */
  ...group('allen-bradley', 'vendor', [
    'allen-bradley',
    'allen bradley',
    'ab',
    'rockwell',
    'rockwell automation',
    'controllogix',
    'compactlogix',
    'micrologix',
    'slc 500',
    'plc-5',
    'studio 5000',
    'rslinx',
  ]),
  ...group('siemens', 'vendor', [
    'siemens',
    's7',
    's7comm',
    'simatic',
    's7-300',
    's7-400',
    's7-1200',
    's7-1500',
    'tia portal',
    'step 7',
  ]),
  ...group('schneider', 'vendor', [
    'schneider',
    'schneider electric',
    'modicon',
    'quantum',
    'm340',
    'unity pro',
  ]),
  ...group('mitsubishi', 'vendor', ['mitsubishi', 'mitsubishi electric', 'melsec', 'cc-link', 'cc-link ie']),
  ...group('omron', 'vendor', ['omron', 'sysmac', 'fins']),
  ...group('inductive-automation', 'vendor', ['ignition', 'inductive automation']),

  /* protocols */
  ...group('opc-ua', 'protocol', ['opc ua', 'opcua', 'opc-ua', 'ua', 'iec 62541']),
  ...group('opc-classic', 'protocol', ['opc da', 'opcda', 'opc classic', 'opc 2.0', 'dcom opc']),
  ...group('opc-ae', 'protocol', ['opc ae', 'opc a&e', 'opc alarms and events', 'opc ua a&c']),
  ...group('modbus', 'protocol', [
    'modbus',
    'modbus tcp',
    'modbus rtu',
    'modbus ascii',
    'modbus serial',
    'mbtcp',
  ]),
  ...group('ethernet-ip', 'protocol', ['ethernet/ip', 'ethernet ip', 'enip', 'cip', 'common industrial protocol']),
  ...group('mqtt', 'protocol', ['mqtt', 'sparkplug', 'sparkplug b', 'mqtt sparkplug']),
  ...group('bacnet', 'protocol', ['bacnet', 'bacnet/ip', 'bacnet ip', 'bacnet ms/tp', 'ms/tp']),
  ...group('dnp3', 'protocol', ['dnp3', 'dnp 3.0', 'distributed network protocol']),
  ...group('profinet', 'protocol', ['profinet', 'profibus', 'profinet io']),
  ...group('iec-61850', 'protocol', ['iec 61850', '61850', 'mms', 'goose']),
  ...group('serial', 'protocol', ['rs-232', 'rs232', 'rs-485', 'rs485', 'serial', 'ascii serial']),

  /* devices */
  ...group('controller', 'device', ['plc', 'controller', 'processor', 'cpu', 'pac']),
  ...group('rtu', 'device', ['rtu', 'remote terminal unit', 'outstation']),
  ...group('hmi', 'device', ['hmi', 'operator station', 'panel', 'scada client']),
  ...group('gateway', 'device', ['gateway', 'bridge', 'converter', 'protocol converter']),
  ...group('ied', 'device', ['ied', 'intelligent electronic device', 'relay', 'protection relay']),

  /* concepts */
  ...group('tag', 'concept', ['tag', 'point', 'register', 'address', 'item', 'datapoint', 'data point']),
  ...group('historian', 'concept', [
    'historian',
    'data logger',
    'datalogger',
    'time series database',
    'timeseries',
    'process historian',
  ]),
  ...group('redundancy', 'concept', ['redundancy', 'failover', 'hot standby', 'high availability', 'ha']),
  ...group('store-and-forward', 'concept', ['store and forward', 'store-and-forward', 'buffering', 'backfill']),
  ...group('license', 'concept', ['license', 'licence', 'seat', 'subscription', 'perpetual']),
  ...group('database', 'concept', [
    'sql server',
    'mssql',
    'microsoft sql',
    'postgres',
    'postgresql',
    'timescaledb',
    'influxdb',
    'snowflake',
    'database',
  ]),
  ...group('alarm', 'concept', ['alarm', 'alert', 'event', 'notification']),
];

export const SEED_SYNONYM_COUNT = SEED_SYNONYMS.length;
