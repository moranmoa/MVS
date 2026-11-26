import { chat } from './lib.mjs';

export default async function run() {
  // ---- rough performance check (headless, software rendering: indicative only) --
  {
    const p = await chat('?demo=1&still=1&lang=he&theme=dark', 'x', { colorScheme: 'dark' });
    const result = await p.evaluate(async () => {
      const el = document.querySelector('.message-scroll');
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const times = [];
      let t = performance.now();
      // Scroll up through the 100k-message channel, 60 px per frame, for 300 frames.
      for (let i = 0; i < 300; i++) {
        el.scrollTop -= 60;
        await frame();
        const now = performance.now();
        times.push(now - t);
        t = now;
      }
      // Jump to the middle of the channel.
      const j0 = performance.now();
      el.scrollTop = el.scrollHeight / 2;
      await frame();
      await frame();
      const jump = performance.now() - j0;
      // Switch server and back.
      const buttons = document.querySelectorAll('.rail .rail-button');
      const s0 = performance.now();
      buttons[2].click();
      await frame();
      const switchMs = performance.now() - s0;
      times.sort((a, b) => a - b);
      return {
        avgFrameMs: times.reduce((a, b) => a + b, 0) / times.length,
        p95FrameMs: times[Math.floor(times.length * 0.95)],
        rowsInDom: document.querySelectorAll('[role=article]').length,
        jumpToMiddleMs: jump,
        serverSwitchMs: switchMs,
      };
    });
    console.log('perf', JSON.stringify(result, null, 2));
    await p.close();
  }
}
