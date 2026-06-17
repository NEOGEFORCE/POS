package main

import (
	"io/ioutil"
	"log"
	"strings"
)

func main() {
	content, err := ioutil.ReadFile("internal/adapters/jobs/cron_jobs.go")
	if err != nil {
		log.Fatal(err)
	}

	text := string(content)

	// Fix 1: Date fix
	oldDate := "dateStr := o.ExpectedDate\n\t\t\t\tif len(dateStr) > 10 {\n\t\t\t\t\tdateStr = dateStr[:10]\n\t\t\t\t}"
	newDate := "dateStr := o.ExpectedDate.Format(\"2006-01-02\")"
	text = strings.Replace(text, oldDate, newDate, 1)

	// Fix 2: Remove models import if it is not used anymore (but let's just let it be, or replace it)
	text = strings.Replace(text, "\"backPOS-go/internal/core/domain/models\"\n", "", 1)

	err = ioutil.WriteFile("internal/adapters/jobs/cron_jobs.go", []byte(text), 0644)
	if err != nil {
		log.Fatal(err)
	}
}
