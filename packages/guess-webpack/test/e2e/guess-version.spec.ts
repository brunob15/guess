describe('Guess.js version in html tag', () => {
  const puppeteer = require('puppeteer');

  const packageJson = require('../../../../package.json');
  const guessVersion = packageJson.version;

  let browser: any;
  let page: any;

  beforeAll(async () => {
    browser = await puppeteer.launch();
    page = await browser.newPage();
  });

  describe('new page', () => {
    it('should contain a guess-version attribute in body or head html tag', async () => {
      await page.goto('http://localhost:5122/prefetch/dist/index.html', {
        waitUntil: 'networkidle0'
      });

      expect((await page.$$('body'))[0].getAttribute('guess-version')).toBe(guessVersion);
    });
  });

  afterAll(async () => {
    await browser.close();
  });
});
