import { describe, expect, it } from 'vitest';
import { SEED_SYNONYMS } from '@/lib/db/synonyms';
import {
  cosineSimilarity,
  EMBEDDING_DIMENSIONS,
  HashingEmbedder,
  l2Normalize,
} from '@/lib/search/embedding';
import { SynonymGraph } from '@/lib/search/synonym-graph';

const graph = new SynonymGraph(SEED_SYNONYMS);
const embedder = new HashingEmbedder(graph);
const plain = new HashingEmbedder(null);

function sim(a: string, b: string, e = embedder): number {
  return cosineSimilarity(e.embedSync(a), e.embedSync(b));
}

describe('vector shape', () => {
  it('produces the dimension the schema declares', () => {
    expect(embedder.embedSync('opc ua server')).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it('produces unit vectors, so cosine is a dot product', () => {
    const v = embedder.embedSync('modbus tcp gateway');
    const magnitude = Math.sqrt(v.reduce((n, x) => n + x * x, 0));
    expect(magnitude).toBeCloseTo(1, 10);
  });

  it('is deterministic across calls', () => {
    expect(embedder.embedSync('historian connector')).toEqual(
      embedder.embedSync('historian connector'),
    );
  });

  it('embeds empty text without producing NaN', () => {
    const v = embedder.embedSync('');
    expect(v).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(v.every((x) => Number.isFinite(x))).toBe(true);
  });

  it('is insensitive to case and punctuation', () => {
    expect(sim('OPC UA Server!', 'opc ua server')).toBeCloseTo(1, 6);
  });
});

describe('what the embedder is for', () => {
  it('survives a misspelling, which is where BM25 fails outright', () => {
    const misspelled = sim('modbis gateway', 'modbus gateway');
    const unrelated = sim('modbis gateway', 'historian connector');
    expect(misspelled).toBeGreaterThan(0.5);
    expect(misspelled).toBeGreaterThan(unrelated * 2);
  });

  it('puts vendor aliases near each other via the synonym graph', () => {
    const withGraph = sim('Rockwell controller', 'Allen-Bradley controller');
    const withoutGraph = sim('Rockwell controller', 'Allen-Bradley controller', plain);
    expect(withGraph).toBeGreaterThan(withoutGraph);
  });

  it('puts protocol aliases near each other', () => {
    expect(sim('EtherNet/IP device', 'CIP device')).toBeGreaterThan(
      sim('EtherNet/IP device', 'CIP device', plain),
    );
  });

  it('keeps genuinely different topics apart', () => {
    const related = sim('opc ua server for allen-bradley', 'opc ua server for siemens');
    const unrelated = sim('opc ua server for allen-bradley', 'mobile alarm notifier');
    expect(related).toBeGreaterThan(unrelated);
  });

  it('ranks a matching product above a non-matching one', () => {
    const query = 'get tag data from a ControlLogix into SQL Server';
    const right = 'Streamline Connector for SQL Server writes tag data from ControlLogix over EtherNet/IP into SQL Server';
    const wrong = 'Probe Certificate Manager issues and renews OPC UA application certificates';
    expect(sim(query, right)).toBeGreaterThan(sim(query, wrong));
  });

  it('does not let a long description swamp a short precise name', () => {
    const query = 'sparkplug edge node';
    const short = 'Uplink MQTT Sparkplug B Edge Node';
    const padded = `Some unrelated preamble. ${'filler words here. '.repeat(40)} sparkplug`;
    expect(sim(query, short)).toBeGreaterThan(sim(query, padded));
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    const a = l2Normalize([1, 0, 0]);
    const b = l2Normalize([0, 1, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 10);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 10);
  });

  it('refuses vectors of different lengths rather than returning nonsense', () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/dimension mismatch/);
  });
});

describe('l2Normalize', () => {
  it('leaves a zero vector as zeros rather than NaN', () => {
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('scales to unit length', () => {
    const v = l2Normalize([3, 4]);
    expect(Math.sqrt(v[0]! ** 2 + v[1]! ** 2)).toBeCloseTo(1, 10);
  });
});
