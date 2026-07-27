import { describe, it, expect } from 'vitest';
import { stripDeviceAttrReports } from './termReports';

const ESC = '\x1b';

describe('stripDeviceAttrReports', () => {
  it('drops a DA1 response', () => {
    expect(stripDeviceAttrReports(`${ESC}[?1;2c`)).toBe('');
  });

  it('drops a DA2 response', () => {
    expect(stripDeviceAttrReports(`${ESC}[>0;276;0c`)).toBe('');
  });

  it('drops a DA3 response', () => {
    expect(stripDeviceAttrReports(`${ESC}[=1c`)).toBe('');
  });

  it('drops the observed leak (DA1+DA2 concatenated, repeated)', () => {
    const leak = `${ESC}[?1;2c${ESC}[>0;276;0c`.repeat(3);
    expect(stripDeviceAttrReports(leak)).toBe('');
  });

  it('strips a report embedded between real keystrokes', () => {
    expect(stripDeviceAttrReports(`ls${ESC}[>0;276;0c\r`)).toBe('ls\r');
  });

  it('leaves plain typed text untouched', () => {
    expect(stripDeviceAttrReports('git status\r')).toBe('git status\r');
  });

  it('leaves arrow / function keys untouched (no ?/>/= intermediate, letter final)', () => {
    expect(stripDeviceAttrReports(`${ESC}[A`)).toBe(`${ESC}[A`);       // up
    expect(stripDeviceAttrReports(`${ESC}[1;5C`)).toBe(`${ESC}[1;5C`); // ctrl-right
    expect(stripDeviceAttrReports(`${ESC}OB`)).toBe(`${ESC}OB`);       // app-mode down
  });

  it('leaves a cursor-position report (…R) untouched — apps consume it', () => {
    expect(stripDeviceAttrReports(`${ESC}[24;80R`)).toBe(`${ESC}[24;80R`);
  });

  it('leaves DSR (…n) and mouse (…M) reports untouched', () => {
    expect(stripDeviceAttrReports(`${ESC}[0n`)).toBe(`${ESC}[0n`);
    expect(stripDeviceAttrReports(`${ESC}[<0;13;7M`)).toBe(`${ESC}[<0;13;7M`);
  });
});
