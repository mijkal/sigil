package tui

import (
	"reflect"
	"testing"
)

func TestFuzzyFilter(t *testing.T) {
	labels := []string{
		"the hub host / web",
		"the hub host / api",
		"a Docker host / build",
		"rabble-af / web-worker",
		"kwanchai / notes",
	}

	tests := []struct {
		name  string
		query string
		want  []string
	}{
		{
			name:  "empty query returns everything unchanged",
			query: "",
			want:  labels,
		},
		{
			name:  "subsequence match filters to the subset",
			query: "web",
			want:  []string{"the hub host / web", "rabble-af / web-worker"},
		},
		{
			name:  "word-boundary match outranks a scattered subsequence",
			query: "uweb",
			want:  []string{"the hub host / web"},
		},
		{
			name:  "host prefix narrows to one host",
			query: "docker",
			want:  []string{"a Docker host / build"},
		},
		{
			name:  "no match yields empty",
			query: "zzz",
			want:  []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := fuzzyFilter(labels, tt.query)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("fuzzyFilter(%q)\n got = %#v\nwant = %#v", tt.query, got, tt.want)
			}
		})
	}
}

func TestFuzzyMatchOrdering(t *testing.T) {
	// "web" is a contiguous, boundary-aligned match in "a / web" but scattered
	// in "w-e-b-x"; the boundary match must score higher.
	tight, ok1 := fuzzyMatch("host / web", "web")
	loose, ok2 := fuzzyMatch("w_e_b_x", "web")
	if !ok1 || !ok2 {
		t.Fatalf("both should match: tight=%v loose=%v", ok1, ok2)
	}
	if tight <= loose {
		t.Errorf("boundary/consecutive match should score higher: tight=%d loose=%d", tight, loose)
	}
}
