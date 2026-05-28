package main

import (
	bytes
	encoding/json
	fmt
	io/ioutil
	net/http
	os
)

func main() {
	apiKey := os.Getenv(ANTHROPIC_API_KEY)
	if apiKey == " {
 fmt.Println(No ANTHROPIC_API_KEY)
 return
 }

 url := https://api.anthropic.com/v1/messages
 
 reqBody := map[string]interface{}{
 model: claude-3-5-sonnet-20241022,
 max_tokens: 4000,
 temperature: 0.0,
 messages: []map[string]interface{}{
 {
 role: user,
 content: []map[string]interface{}{
 {
 type: text,
 text: Hello,
 },
 },
 },
 },
 }

 jsonData, _ := json.Marshal(reqBody)
 req, _ := http.NewRequest(POST, url, bytes.NewBuffer(jsonData))
 req.Header.Set(Content-Type, application/json)
 req.Header.Set(x-api-key, apiKey)
 req.Header.Set(anthropic-version, 2023-06-01)

 client := &http.Client{}
 resp, err := client.Do(req)
 if err != nil {
 fmt.Println(Error:, err)
 return
 }
 defer resp.Body.Close()

 bodyBytes, _ := ioutil.ReadAll(resp.Body)
 fmt.Printf(Status: %d\nBody: %s\n, resp.StatusCode, string(bodyBytes))
}
