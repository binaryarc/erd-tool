-- MySQL 어댑터 시험용 스키마 (STEP 9). 도커 MySQL 의 erdtest DB. 시험 시작에 지우고 다시 넣는다.
-- 단일과 복합 PK, 복합 FK, ON DELETE CASCADE, UNIQUE, 일반과 UNIQUE 인덱스, AUTO_INCREMENT, 기본값, 생성 컬럼, 코멘트, CHECK, 뷰(경고 확인용)
DROP VIEW IF EXISTS erd_v_order;
DROP TABLE IF EXISTS erd_order_item;
DROP TABLE IF EXISTS erd_order;
DROP TABLE IF EXISTS erd_product;
DROP TABLE IF EXISTS erd_customer;
DROP TABLE IF EXISTS erd_code;
CREATE TABLE erd_customer (
  cust_id int NOT NULL AUTO_INCREMENT,
  cust_cd varchar(20) NOT NULL COMMENT '거래처 코드',
  cust_nm varchar(100) NOT NULL,
  grade char(1) NOT NULL DEFAULT 'A',
  reg_dt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (cust_id),
  CONSTRAINT uq_erd_customer_cd UNIQUE (cust_cd),
  CONSTRAINT ck_erd_customer_grade CHECK (grade IN ('A', 'B', 'C'))
) COMMENT = '거래처';
CREATE TABLE erd_product (
  prod_cd varchar(20) NOT NULL,
  prod_nm varchar(200) NOT NULL,
  price decimal(12,2) NULL,
  memo text NULL,
  PRIMARY KEY (prod_cd)
);
CREATE TABLE erd_order (
  order_no varchar(20) NOT NULL,
  order_seq int NOT NULL,
  cust_id int NOT NULL,
  order_dt date NOT NULL,
  amount decimal(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (order_no, order_seq),
  CONSTRAINT fk_erd_order_cust FOREIGN KEY (cust_id) REFERENCES erd_customer (cust_id) ON DELETE CASCADE
) COMMENT = '주문';
CREATE TABLE erd_order_item (
  order_no varchar(20) NOT NULL,
  order_seq int NOT NULL,
  item_no int NOT NULL,
  prod_cd varchar(20) NOT NULL,
  qty int NOT NULL,
  qty2 int GENERATED ALWAYS AS (qty * 2) STORED,
  PRIMARY KEY (order_no, order_seq, item_no),
  CONSTRAINT fk_erd_item_order FOREIGN KEY (order_no, order_seq) REFERENCES erd_order (order_no, order_seq) ON DELETE CASCADE,
  CONSTRAINT fk_erd_item_prod FOREIGN KEY (prod_cd) REFERENCES erd_product (prod_cd)
);
CREATE TABLE erd_code (
  grp_cd varchar(10) NOT NULL,
  cd varchar(10) NOT NULL,
  cd_nm varchar(50) NULL,
  PRIMARY KEY (grp_cd, cd)
);
CREATE INDEX ix_erd_order_cust ON erd_order (cust_id, order_dt);
CREATE UNIQUE INDEX ux_erd_product_nm ON erd_product (prod_nm);
CREATE VIEW erd_v_order AS SELECT o.order_no, c.cust_nm FROM erd_order o JOIN erd_customer c ON c.cust_id = o.cust_id;
