import { describe, expect, test } from "bun:test";

import { normalize_issue_repos, screenshot_asset_raw_url, screenshot_asset_url } from "./issue_reporter";

describe("issue reporter repo list", () => {
	test("normalizes the array form and keeps declaration order", () => {
		expect(normalize_issue_repos(["reepolee/reepolee-dev", "other/project"])).toEqual([
			"reepolee/reepolee-dev",
			"other/project",
		]);
	});

	test("accepts the legacy single-string form as a one-element list", () => {
		expect(normalize_issue_repos("reepolee/reepolee-dev")).toEqual(["reepolee/reepolee-dev"]);
	});

	test("drops invalid and duplicate entries", () => {
		expect(normalize_issue_repos(["reepolee/reepolee-dev", "not-a-repo", "reepolee/reepolee-dev", ""])).toEqual([
			"reepolee/reepolee-dev",
		]);
	});

	test("returns an empty list when nothing is configured", () => {
		expect(normalize_issue_repos(undefined)).toEqual([]);
	});
});

describe("issue reporter screenshot URLs", () => {
	test("uses the authenticated GitHub blob path", () => {
		expect(screenshot_asset_url("reepolee/reepolee-dev", "github-assets/example.png")).toBe(
			"https://github.com/reepolee/reepolee-dev/blob/screenshots/github-assets/example.png",
		);
	});

	test("uses the authenticated GitHub raw path for image sources", () => {
		expect(screenshot_asset_raw_url("reepolee/reepolee-dev", "github-assets/example.png")).toBe(
			"https://github.com/reepolee/reepolee-dev/raw/screenshots/github-assets/example.png",
		);
	});
});
