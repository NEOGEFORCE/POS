package main

import (
	"fmt"
	"io"
	"os"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

func main() {
	bot, err := tgbotapi.NewBotAPI("8642401432:AAF4CQrvXfFoAzyvG2V-d3aTrSqTSeqLQvc")
	if err != nil {
		fmt.Println("Bot err:", err)
		return
	}
	file, err := os.Open("test.sql")
	if err != nil {
		fmt.Println("File err:", err)
		return
	}
	b, _ := io.ReadAll(file)
	doc := tgbotapi.NewDocument(5019628056, tgbotapi.FileBytes{Name: "test.sql", Bytes: b})
	_, err = bot.Send(doc)
	fmt.Println("Send err:", err)
}
