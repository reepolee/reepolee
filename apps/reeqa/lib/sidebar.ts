import { get_active_page_set, list_page_sets, page_set_capture_size, page_set_page_count } from "./page_set_store";
import { get_active_project_id, list_projects } from "./project_store";

/**
 * Data for the shared-layout sidebar selectors, rendered above the nav entries
 * (mirroring the Studio file selector). Every ReeQA page includes this in its
 * render data; the selectors are the single place the active project and the
 * active page set are chosen, so pages never carry their own selection.
 */
export type Reeqa_project_selector = {
	action: string;
	next: string;
	label: string;
	active_project_id: string;
	projects: Array<{ id: string; name: string; }>;
};

export type Reeqa_page_set_selector = {
	action: string;
	next: string;
	label: string;
	active_page_set_id?: string;
	page_sets: Array<{ id: string; name: string; page_count: number; capture_width: number; }>;
};

export async function sidebar_props(request_url: string | undefined): Promise<{
	reeqa_project_selector?: Reeqa_project_selector;
	reeqa_page_set_selector?: Reeqa_page_set_selector;
}> {
	const projects = await list_projects();
	if (projects.length === 0) return {};
	const active_project_id = (await get_active_project_id()) ?? projects[0]!.id;
	const page_sets = await list_page_sets(active_project_id);
	const active_page_set = await get_active_page_set(active_project_id);
	return {
		reeqa_project_selector: {
			action: "/projects/active",
			next: request_url ?? "/",
			label: "Project",
			active_project_id,
			projects: projects.map((project) => ({ id: project.id, name: project.name })),
		},
		reeqa_page_set_selector: {
			action: "/page-sets/active",
			next: request_url ?? "/",
			label: "Page set",
			active_page_set_id: active_page_set?.id,
			page_sets: page_sets.map((page_set) => ({
				id: page_set.id,
				name: page_set.name,
				page_count: page_set_page_count(page_set),
				capture_width: page_set_capture_size(page_set).width,
			})),
		},
	};
}
