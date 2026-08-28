package middlewares

import "testing"

func TestRoleAllowedDoesNotGrantAuditorAdminAccess(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		userRole     string
		requiredRole string
		want         bool
	}{
		{name: "auditor denied admin", userRole: "auditor", requiredRole: "admin", want: false},
		{name: "auditor denied employee", userRole: "auditor", requiredRole: "empleado", want: false},
		{name: "auditor allowed auditor", userRole: "auditor", requiredRole: "auditor", want: true},
		{name: "admin allowed admin", userRole: "administrador", requiredRole: "admin", want: true},
		{name: "admin allowed employee", userRole: "admin", requiredRole: "empleado", want: true},
		{name: "superadmin allowed admin", userRole: "superadmin", requiredRole: "admin", want: true},
		{name: "employee allowed employee", userRole: "employee", requiredRole: "empleado", want: true},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := roleAllowed(test.userRole, test.requiredRole); got != test.want {
				t.Fatalf("roleAllowed(%q, %q) = %v; want %v", test.userRole, test.requiredRole, got, test.want)
			}
		})
	}
}
