// Test-only encrypted fixture writer. Never bundled in the app.
#include "sqlite3.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc,char **argv){if(argc!=3)return 2;sqlite3 *db=0;if(sqlite3_open(argv[1],&db))return 3;char key[65],raw[70];if(!fgets(key,sizeof key,stdin))return 4;snprintf(raw,sizeof raw,"x'%s'",key);sqlite3_key(db,raw,(int)strlen(raw));
const char *sql=strcmp(argv[2],"contact")==0?"CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT); INSERT INTO contact VALUES('test-peer','测试联系人','测试备注');":"CREATE TABLE Name2Id(user_name TEXT); INSERT INTO Name2Id VALUES('test-peer'),('test-self'); CREATE TABLE Msg_9d12f513aaed8741c6ad59d7db326fb7(local_id INTEGER,create_time INTEGER,message_content TEXT,local_type INTEGER,real_sender_id INTEGER); INSERT INTO Msg_9d12f513aaed8741c6ad59d7db326fb7 VALUES(1,1700000000,'项目在周五交付',1,1),(2,1700000001,'收到',1,2);";
char *fixture=0;
if(strcmp(argv[2],"sql")==0){
  fixture=malloc(1048577);if(!fixture)return 6;
  size_t n=fread(fixture,1,1048576,stdin);if(n>=1048576)return 7;
  fixture[n]=0;sql=fixture;
}
int rc=sqlite3_exec(db,sql,0,0,0);free(fixture);sqlite3_close(db);return rc?5:0;}
