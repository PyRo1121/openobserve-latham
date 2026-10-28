import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createStore } from "vuex";
import WebTrafficView from "./WebTrafficView.vue";

vi.mock("@/utils/zincutils", () => ({ routeGuard: vi.fn() }));
vi.mock("@/composables/shared/useIngestionRoutes", () => ({ default: () => [] }));

import useOSRoutes from "@/composables/router";
import { routeGuard } from "@/utils/zincutils";

describe("native Web traffic view", () => {
  it("embeds only the traffic content under the current API prefix and follows native theme", async () => {
    const store = createStore({ state: { API_ENDPOINT: "https://dashboard.latham.cloud/_next/", theme: "light" } });
    const wrapper = mount(WebTrafficView, { global: { plugins: [store] } });
    const frame = wrapper.get("iframe");
    expect(frame.attributes("src")).toBe("https://dashboard.latham.cloud/_next/_observatory/visitors?embedded=1&theme=light");
    expect(frame.attributes("title")).toBe("Website traffic");
    expect(frame.attributes("loading")).toBe("eager");
    expect(wrapper.find("nav").exists()).toBe(false);
    expect(wrapper.find("header").exists()).toBe(false);
    store.state.theme = "dark";
    await wrapper.vm.$nextTick();
    expect(frame.attributes("src")).toBe("https://dashboard.latham.cloud/_next/_observatory/visitors?embedded=1&theme=dark");
    wrapper.unmount();
  });

  it("registers an authenticated native route with a lazy component", () => {
    const route = useOSRoutes().homeChildRoutes.find((entry: { name?: string }) => entry.name === "webTraffic");
    expect(route?.path).toBe("traffic");
    expect(route?.beforeEnter).toBe(routeGuard);
    expect(route?.meta).toEqual({ title: "Web traffic", keepAlive: false });
    expect(typeof route?.component).toBe("function");
  });
});
