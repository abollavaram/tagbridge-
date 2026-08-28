/**
 * The golden query set.
 *
 * 100 queries in four buckets of 25, each labelled with the products a
 * knowledgeable salesperson would consider a correct answer. Labels are
 * generous where a query genuinely has several right answers and strict where
 * it has one — a part number means one product, and the evaluation says so.
 *
 * The buckets exist because they fail differently:
 *
 *   part-number    BM25 should win outright; embeddings fumble exact strings
 *   problem-shaped the buyer describes a symptom and never names the product
 *   synonym        the query and the catalogue use different words for one thing
 *   compatibility  "will this work with what I already have"
 */

export type Bucket = 'part-number' | 'problem-shaped' | 'synonym' | 'compatibility';

export interface GoldenQuery {
  id: string;
  bucket: Bucket;
  query: string;
  /** SKUs a correct system should return. Order is not significant. */
  relevant: string[];
}

export const GOLDEN_QUERIES: GoldenQuery[] = [
  /* ------------------------------------------------- part-number lookups */
  { id: 'pn-01', bucket: 'part-number', query: 'TB-OPCUA-4100', relevant: ['TB-OPCUA-4100'] },
  { id: 'pn-02', bucket: 'part-number', query: 'TB-OPCUA-4200', relevant: ['TB-OPCUA-4200'] },
  { id: 'pn-03', bucket: 'part-number', query: 'TB-OPCUA-4300', relevant: ['TB-OPCUA-4300'] },
  { id: 'pn-04', bucket: 'part-number', query: 'TB-OPCDA-4400', relevant: ['TB-OPCDA-4400'] },
  { id: 'pn-05', bucket: 'part-number', query: 'TB-OPCUA-4700', relevant: ['TB-OPCUA-4700'] },
  { id: 'pn-06', bucket: 'part-number', query: 'TB-GW-5100', relevant: ['TB-GW-5100'] },
  { id: 'pn-07', bucket: 'part-number', query: 'TB-GW-5200', relevant: ['TB-GW-5200'] },
  { id: 'pn-08', bucket: 'part-number', query: 'TB-GW-5800', relevant: ['TB-GW-5800'] },
  { id: 'pn-09', bucket: 'part-number', query: 'TB-GW-6000', relevant: ['TB-GW-6000'] },
  { id: 'pn-10', bucket: 'part-number', query: 'TB-HIST-6100', relevant: ['TB-HIST-6100'] },
  { id: 'pn-11', bucket: 'part-number', query: 'TB-HIST-6400', relevant: ['TB-HIST-6400'] },
  { id: 'pn-12', bucket: 'part-number', query: 'TB-MQTT-7100', relevant: ['TB-MQTT-7100'] },
  { id: 'pn-13', bucket: 'part-number', query: 'TB-MQTT-7300', relevant: ['TB-MQTT-7300'] },
  { id: 'pn-14', bucket: 'part-number', query: 'TB-HMI-8300', relevant: ['TB-HMI-8300'] },
  { id: 'pn-15', bucket: 'part-number', query: 'TB-RED-9100', relevant: ['TB-RED-9100'] },
  { id: 'pn-16', bucket: 'part-number', query: 'TB-DIAG-9700', relevant: ['TB-DIAG-9700'] },
  { id: 'pn-17', bucket: 'part-number', query: 'TB-DIAG-9950', relevant: ['TB-DIAG-9950'] },
  { id: 'pn-18', bucket: 'part-number', query: 'do you stock TB-OPCUA-4600', relevant: ['TB-OPCUA-4600'] },
  { id: 'pn-19', bucket: 'part-number', query: 'price for TB-GW-5300', relevant: ['TB-GW-5300'] },
  { id: 'pn-20', bucket: 'part-number', query: 'need a quote on TB-HIST-6200', relevant: ['TB-HIST-6200'] },
  { id: 'pn-21', bucket: 'part-number', query: 'TB-OPCUA-4100-M', relevant: ['TB-OPCUA-4100'] },
  { id: 'pn-22', bucket: 'part-number', query: 'TB-GW-5200-L', relevant: ['TB-GW-5200'] },
  { id: 'pn-23', bucket: 'part-number', query: 'TB-DIAG-9600-SITE', relevant: ['TB-DIAG-9600'] },
  { id: 'pn-24', bucket: 'part-number', query: 'tb-mqtt-7500', relevant: ['TB-MQTT-7500'] },
  { id: 'pn-25', bucket: 'part-number', query: 'is TB-HMI-8700 still available', relevant: ['TB-HMI-8700'] },

  /* --------------------------------------------------- problem-shaped */
  {
    id: 'ps-01',
    bucket: 'problem-shaped',
    query: 'get tag data from a ControlLogix into SQL Server',
    relevant: ['TB-HIST-6100', 'TB-OPCUA-4100', 'TB-HIST-6700'],
  },
  {
    id: 'ps-02',
    bucket: 'problem-shaped',
    query: 'my Modbus device will not talk to my SCADA',
    relevant: ['TB-OPCUA-4300', 'TB-GW-5400', 'TB-DIAG-9700', 'TB-GW-5200'],
  },
  {
    id: 'ps-03',
    bucket: 'problem-shaped',
    query: 'need OPC UA on a legacy DA server',
    relevant: ['TB-OPCDA-4400', 'TB-OPCUA-4500'],
  },
  {
    id: 'ps-04',
    bucket: 'problem-shaped',
    query: 'we lose data when the network drops overnight',
    relevant: ['TB-RED-9300', 'TB-MQTT-7500', 'TB-HIST-6500'],
  },
  {
    id: 'ps-05',
    bucket: 'problem-shaped',
    query: 'push plant data to the cloud for analytics',
    relevant: ['TB-HIST-6400', 'TB-MQTT-7200', 'TB-MQTT-7400', 'TB-HIST-6300'],
  },
  {
    id: 'ps-06',
    bucket: 'problem-shaped',
    query: 'operators say the HMI screens are slow when everyone opens them',
    relevant: ['TB-HMI-8100'],
  },
  {
    id: 'ps-07',
    bucket: 'problem-shaped',
    query: 'too many nuisance alarms flooding the operators',
    relevant: ['TB-HMI-8200'],
  },
  {
    id: 'ps-08',
    bucket: 'problem-shaped',
    query: 'need a record of every recipe download for the auditors',
    relevant: ['TB-HMI-8300', 'TB-DIAG-9970'],
  },
  {
    id: 'ps-09',
    bucket: 'problem-shaped',
    query: 'connect a barcode scanner to a ControlLogix program',
    relevant: ['TB-GW-5700'],
  },
  {
    id: 'ps-10',
    bucket: 'problem-shaped',
    query: 'chiller data needs to reach the process historian',
    relevant: ['TB-OPCUA-4600', 'TB-GW-5600'],
  },
  {
    id: 'ps-11',
    bucket: 'problem-shaped',
    query: 'analogue values look frozen but the connector says healthy',
    relevant: ['TB-DIAG-9960'],
  },
  {
    id: 'ps-12',
    bucket: 'problem-shaped',
    query: 'certificates expired overnight and nothing would reconnect',
    relevant: ['TB-DIAG-9950'],
  },
  {
    id: 'ps-13',
    bucket: 'problem-shaped',
    query: 'need shift reports emailed automatically every morning',
    relevant: ['TB-HMI-8500'],
  },
  {
    id: 'ps-14',
    bucket: 'problem-shaped',
    query: 'want alarms sent to the on-call engineer phone at night',
    relevant: ['TB-HMI-8600'],
  },
  {
    id: 'ps-15',
    bucket: 'problem-shaped',
    query: 'backfill a week of missing history after the server was rebuilt',
    relevant: ['TB-HIST-6500', 'TB-RED-9300'],
  },
  {
    id: 'ps-16',
    bucket: 'problem-shaped',
    query: 'log a few hundred points to file at a remote site with no historian',
    relevant: ['TB-HIST-6600'],
  },
  {
    id: 'ps-17',
    bucket: 'problem-shaped',
    query: 'we need the server to stay up when one machine fails',
    relevant: ['TB-RED-9100', 'TB-RED-9200', 'TB-RED-9400'],
  },
  {
    id: 'ps-18',
    bucket: 'problem-shaped',
    query: 'find out how much traffic our polling will put on the network',
    relevant: ['TB-DIAG-9900'],
  },
  {
    id: 'ps-19',
    bucket: 'problem-shaped',
    query: 'thirty separate servers and the client has to connect to each one',
    relevant: ['TB-OPCUA-4500'],
  },
  {
    id: 'ps-20',
    bucket: 'problem-shaped',
    query: 'attach batch numbers to the time series rows',
    relevant: ['TB-HIST-6700'],
  },
  {
    id: 'ps-21',
    bucket: 'problem-shaped',
    query: 'show a read-only process dashboard to the office without a SCADA seat',
    relevant: ['TB-HMI-8400'],
  },
  {
    id: 'ps-22',
    bucket: 'problem-shaped',
    query: 'build the address space from an existing controller program export',
    relevant: ['TB-HMI-8700'],
  },
  {
    id: 'ps-23',
    bucket: 'problem-shaped',
    query: 'stream tags to a time series database for the data team',
    relevant: ['TB-HIST-6300', 'TB-HIST-6200', 'TB-HIST-6400'],
  },
  {
    id: 'ps-24',
    bucket: 'problem-shaped',
    query: 'keep configuration identical across a redundant pair',
    relevant: ['TB-RED-9500'],
  },
  {
    id: 'ps-25',
    bucket: 'problem-shaped',
    query: 'prove whether the problem is the server or the network',
    relevant: ['TB-DIAG-9600', 'TB-DIAG-9900'],
  },

  /* ------------------------------------------------------ synonym-dependent */
  {
    id: 'sy-01',
    bucket: 'synonym',
    query: 'Rockwell PLC connector',
    relevant: ['TB-OPCUA-4100', 'TB-GW-5100', 'TB-DIAG-9800', 'TB-GW-5700'],
  },
  {
    id: 'sy-02',
    bucket: 'synonym',
    query: 'Allen Bradley driver',
    relevant: ['TB-OPCUA-4100', 'TB-GW-5100', 'TB-DIAG-9800', 'TB-GW-5700'],
  },
  {
    id: 'sy-03',
    bucket: 'synonym',
    query: 'CompactLogix data collection',
    relevant: ['TB-OPCUA-4100', 'TB-DIAG-9800'],
  },
  {
    id: 'sy-04',
    bucket: 'synonym',
    query: 'MicroLogix tag server',
    relevant: ['TB-OPCUA-4100', 'TB-HMI-8100'],
  },
  {
    id: 'sy-05',
    bucket: 'synonym',
    query: 'Studio 5000 tag import',
    relevant: ['TB-HMI-8700'],
  },
  {
    id: 'sy-06',
    bucket: 'synonym',
    query: 'SIMATIC connectivity',
    relevant: ['TB-OPCUA-4200', 'TB-GW-5300', 'TB-GW-5500'],
  },
  {
    id: 'sy-07',
    bucket: 'synonym',
    query: 'S7 driver',
    relevant: ['TB-OPCUA-4200', 'TB-GW-5300'],
  },
  {
    id: 'sy-08',
    bucket: 'synonym',
    query: 'TIA Portal export into an address space',
    relevant: ['TB-HMI-8700'],
  },
  {
    id: 'sy-09',
    bucket: 'synonym',
    query: 'Modicon register mapping',
    relevant: ['TB-OPCUA-4300', 'TB-DIAG-9700', 'TB-RED-9200'],
  },
  {
    id: 'sy-10',
    bucket: 'synonym',
    query: 'Schneider Electric gateway',
    relevant: ['TB-OPCUA-4300', 'TB-GW-5200', 'TB-RED-9200'],
  },
  {
    id: 'sy-11',
    bucket: 'synonym',
    query: 'MELSEC connectivity',
    relevant: ['TB-GW-5900'],
  },
  {
    id: 'sy-12',
    bucket: 'synonym',
    query: 'CIP device browser',
    relevant: ['TB-DIAG-9800', 'TB-GW-5100'],
  },
  {
    id: 'sy-13',
    bucket: 'synonym',
    query: 'OPC Classic to modern clients',
    relevant: ['TB-OPCDA-4400', 'TB-OPCUA-4500'],
  },
  {
    id: 'sy-14',
    bucket: 'synonym',
    query: 'DCOM free OPC DA access',
    relevant: ['TB-OPCDA-4400'],
  },
  {
    id: 'sy-15',
    bucket: 'synonym',
    query: 'Sparkplug B publisher',
    relevant: ['TB-MQTT-7100', 'TB-MQTT-7300'],
  },
  {
    id: 'sy-16',
    bucket: 'synonym',
    query: 'point count licensing',
    relevant: ['TB-GW-6000', 'TB-MQTT-7100'],
  },
  {
    id: 'sy-17',
    bucket: 'synonym',
    query: 'register to OPC UA conversion',
    relevant: ['TB-OPCUA-4300', 'TB-GW-5400'],
  },
  {
    id: 'sy-18',
    bucket: 'synonym',
    query: 'data logger for a remote site',
    relevant: ['TB-HIST-6600', 'TB-MQTT-7500'],
  },
  {
    id: 'sy-19',
    bucket: 'synonym',
    query: 'processor connection diagnostics',
    relevant: ['TB-DIAG-9800', 'TB-DIAG-9900'],
  },
  {
    id: 'sy-20',
    bucket: 'synonym',
    query: 'hot standby for the OPC server',
    relevant: ['TB-RED-9100'],
  },
  {
    id: 'sy-21',
    bucket: 'synonym',
    query: 'high availability Modbus polling',
    relevant: ['TB-RED-9200'],
  },
  {
    id: 'sy-22',
    bucket: 'synonym',
    query: 'outstation polling for water sites',
    relevant: ['TB-OPCUA-4700'],
  },
  {
    id: 'sy-23',
    bucket: 'synonym',
    query: 'protection relay data into SCADA',
    relevant: ['TB-GW-5800'],
  },
  {
    id: 'sy-24',
    bucket: 'synonym',
    query: 'Ignition MQTT integration',
    relevant: ['TB-MQTT-7100', 'TB-MQTT-7300'],
  },
  {
    id: 'sy-25',
    bucket: 'synonym',
    query: 'Microsoft SQL historian writes',
    relevant: ['TB-HIST-6100', 'TB-HIST-6500'],
  },

  /* ---------------------------------------------------------- compatibility */
  {
    id: 'cp-01',
    bucket: 'compatibility',
    query: 'does this work with Modbus RTU over serial',
    relevant: ['TB-GW-5200', 'TB-OPCUA-4300', 'TB-DIAG-9700', 'TB-HIST-6600'],
  },
  {
    id: 'cp-02',
    bucket: 'compatibility',
    query: 'is it compatible with ControlLogix firmware',
    relevant: ['TB-OPCUA-4100', 'TB-DIAG-9800', 'TB-GW-5100'],
  },
  {
    id: 'cp-03',
    bucket: 'compatibility',
    query: 'will it talk to an S7-1500',
    relevant: ['TB-OPCUA-4200', 'TB-GW-5300'],
  },
  {
    id: 'cp-04',
    bucket: 'compatibility',
    query: 'does it support BACnet MS/TP as well as IP',
    relevant: ['TB-OPCUA-4600', 'TB-GW-5600'],
  },
  {
    id: 'cp-05',
    bucket: 'compatibility',
    query: 'can I connect EtherNet/IP equipment to Modbus TCP',
    relevant: ['TB-GW-5100', 'TB-GW-6000'],
  },
  {
    id: 'cp-06',
    bucket: 'compatibility',
    query: 'does it support DNP3 unsolicited responses',
    relevant: ['TB-OPCUA-4700'],
  },
  {
    id: 'cp-07',
    bucket: 'compatibility',
    query: 'will this work with an existing Sparkplug broker',
    relevant: ['TB-MQTT-7300', 'TB-MQTT-7400', 'TB-MQTT-7100'],
  },
  {
    id: 'cp-08',
    bucket: 'compatibility',
    query: 'is PROFINET supported',
    relevant: ['TB-GW-5500'],
  },
  {
    id: 'cp-09',
    bucket: 'compatibility',
    query: 'can it read IEC 61850 from substation IEDs',
    relevant: ['TB-GW-5800'],
  },
  {
    id: 'cp-10',
    bucket: 'compatibility',
    query: 'does it work with CC-Link IE Field',
    relevant: ['TB-GW-5900'],
  },
  {
    id: 'cp-11',
    bucket: 'compatibility',
    query: 'compatible with TimescaleDB hypertables',
    relevant: ['TB-HIST-6200'],
  },
  {
    id: 'cp-12',
    bucket: 'compatibility',
    query: 'does it write to Snowflake',
    relevant: ['TB-HIST-6400'],
  },
  {
    id: 'cp-13',
    bucket: 'compatibility',
    query: 'will it connect to AWS IoT Core',
    relevant: ['TB-MQTT-7200', 'TB-MQTT-7400'],
  },
  {
    id: 'cp-14',
    bucket: 'compatibility',
    query: 'does the redundancy work with plain OPC UA clients',
    relevant: ['TB-RED-9100'],
  },
  {
    id: 'cp-15',
    bucket: 'compatibility',
    query: 'can it serve RS-232 ASCII devices to a controller',
    relevant: ['TB-GW-5700'],
  },
  {
    id: 'cp-16',
    bucket: 'compatibility',
    query: 'does it support OPC alarms and events',
    relevant: ['TB-HMI-8200'],
  },
  {
    id: 'cp-17',
    bucket: 'compatibility',
    query: 'will the SDK work with C as well as .NET',
    relevant: ['TB-OPCUA-4800'],
  },
  {
    id: 'cp-18',
    bucket: 'compatibility',
    query: 'does it work with InfluxDB line protocol',
    relevant: ['TB-HIST-6300'],
  },
  {
    id: 'cp-19',
    bucket: 'compatibility',
    query: 'can it poll two networks to the same Modbus device',
    relevant: ['TB-RED-9200'],
  },
  {
    id: 'cp-20',
    bucket: 'compatibility',
    query: 'does it integrate with SAML or OIDC single sign on',
    relevant: ['TB-HMI-8400'],
  },
  {
    id: 'cp-21',
    bucket: 'compatibility',
    query: 'will it work with Modbus ASCII framing',
    relevant: ['TB-OPCUA-4300', 'TB-GW-5200', 'TB-DIAG-9700'],
  },
  {
    id: 'cp-22',
    bucket: 'compatibility',
    query: 'does it support X.509 certificate revocation',
    relevant: ['TB-DIAG-9950'],
  },
  {
    id: 'cp-23',
    bucket: 'compatibility',
    query: 'can it aggregate both OPC UA and OPC DA servers',
    relevant: ['TB-OPCUA-4500', 'TB-OPCDA-4400'],
  },
  {
    id: 'cp-24',
    bucket: 'compatibility',
    query: 'does the tag server work with Siemens and Allen-Bradley together',
    relevant: ['TB-HMI-8100'],
  },
  {
    id: 'cp-25',
    bucket: 'compatibility',
    query: 'will the alarm notifier work with our OPC UA alarm source',
    relevant: ['TB-HMI-8600', 'TB-HMI-8200'],
  },
];

export const BUCKETS: Bucket[] = [
  'part-number',
  'problem-shaped',
  'synonym',
  'compatibility',
];

export function queriesInBucket(bucket: Bucket): GoldenQuery[] {
  return GOLDEN_QUERIES.filter((q) => q.bucket === bucket);
}
