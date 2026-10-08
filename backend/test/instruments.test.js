import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInstrumentsCsv } from '../src/providers/kiteInstruments.js';

test('parseInstrumentsCsv keeps NIFTY options and futures only', () => {
  const csv = [
    'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
    '10419458,40701,NIFTY26O0622600CE,"NIFTY",0,2026-10-06,22600,0.05,65,CE,NFO-OPT,NFO',
    '12468226,48704,NIFTY26OCTFUT,"NIFTY",0,2026-10-27,0,0.1,65,FUT,NFO-FUT,NFO',
    '1,1,BANKNIFTY26OCTFUT,"BANKNIFTY",0,2026-10-27,0,0.1,30,FUT,NFO-FUT,NFO',
  ].join('\n');
  const rows = parseInstrumentsCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { token: 10419458, tradingsymbol: 'NIFTY26O0622600CE', name: 'NIFTY', expiry: '2026-10-06', strike: 22600, type: 'CE', lotSize: 65 });
});
