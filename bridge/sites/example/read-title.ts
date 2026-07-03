import { Routine } from "../../lib/routine";
import type { Args, Page, Row } from "../../lib/types";

export default class ReadTitleRoutine extends Routine {
  readonly site = "example";
  readonly name = "read-title";
  readonly description = "读取当前页面标题和 URL";
  readonly url = "https://example.com";
  readonly risk = "readonly";
  readonly columns = ["title", "url"];

  async run(page: Page, _args: Args): Promise<Row[]> {
    const info = await page.inspect();
    return [{ title: info.title, url: info.url }];
  }
}
