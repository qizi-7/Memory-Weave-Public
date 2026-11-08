// Test-only writer to keep a genuine encrypted, committed WAL open.
#include "sqlite3.h"
#include <stdio.h>
#include <string.h>
int main(int argc,char **argv){
 if(argc!=2)return 2;char key[132]={0},raw[70]={0};if(!fgets(key,sizeof key,stdin))return 3;key[strcspn(key,"\r\n")]=0;if(strlen(key)!=64)return 3;
 sqlite3 *db=0;if(sqlite3_open(argv[1],&db))return 4;snprintf(raw,sizeof raw,"x'%s'",key);sqlite3_key(db,raw,(int)strlen(raw));
 int rc=sqlite3_exec(db,"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE contact SET nick_name='WAL中新昵称' WHERE username='test-peer';",0,0,0);
 if(rc){sqlite3_close(db);return 5;}puts("READY");fflush(stdout);char stop[10];fgets(stop,sizeof stop,stdin);sqlite3_close(db);return 0;
}
