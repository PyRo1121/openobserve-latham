// Copyright 2026 OpenObserve Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { describe, expect, it, beforeEach, vi } from "vitest";
import queryHistory from "@/services/query_history";
import http from "@/services/http";

vi.mock("@/services/http", () => ({ default: vi.fn() }));

describe("query_history service", () => {
  let api: any;

  beforeEach(() => {
    api = {
      get: vi.fn().mockResolvedValue({ data: [] }),
      post: vi.fn().mockResolvedValue({ data: {} }),
      patch: vi.fn().mockResolvedValue({ data: {} }),
      delete: vi.fn().mockResolvedValue({ data: {} }),
    };
    (http as any).mockReturnValue(api);
  });

  it("records a run with its source, key, streams and status", async () => {
    const body = {
      source: "logs" as const,
      query: "level = 'error'",
      query_key: "k8s|filter|level = 'error'||2026-10-27",
      streams: ["k8s"],
      status: "ok" as const,
      context: { time: { type: "relative" as const, period: "15m", start_time: 1, end_time: 2 } },
    };
    await queryHistory.record("o1", body);
    expect(api.post).toHaveBeenCalledWith("/api/o1/query_history", body);
  });

  it("lists with only the filters that are set", async () => {
    await queryHistory.list("o1", { starred: true, q: "rate" });
    expect(api.get).toHaveBeenCalledWith("/api/o1/query_history", {
      params: { starred: true, q: "rate" },
    });
    await queryHistory.list("o1", {
      source: "logs,traces",
      status: "error",
      stream: "k8s",
      ran_from: 1,
      ran_to: 2,
    });
    expect(api.get).toHaveBeenLastCalledWith("/api/o1/query_history", {
      params: { source: "logs,traces", status: "error", stream: "k8s", ran_from: 1, ran_to: 2 },
    });
  });

  it("clears the caller's history for a scope", async () => {
    await queryHistory.clear("o1", { source: "logs", include_starred: false });
    expect(api.delete).toHaveBeenCalledWith("/api/o1/query_history", {
      params: { source: "logs", include_starred: false },
    });
  });

  it("stars and deletes by id", async () => {
    await queryHistory.star("o1", "id 1", true);
    expect(api.patch).toHaveBeenCalledWith("/api/o1/query_history/id%201", { starred: true });
    await queryHistory.remove("o1", "id 1");
    expect(api.delete).toHaveBeenCalledWith("/api/o1/query_history/id%201");
  });
});
