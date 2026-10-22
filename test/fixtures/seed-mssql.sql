-- SQL Server 어댑터 시험용 스키마 (STEP 9). 도커 SQL Server 의 erdtest DB, dbo 스키마. 시험 시작에 지우고 다시 넣는다.
-- 단일과 복합 PK, 복합 FK, ON DELETE CASCADE, UNIQUE, 일반과 UNIQUE 인덱스, identity, 기본값, 계산 컬럼, 코멘트, CHECK, 시퀀스, 뷰(경고 확인용)
IF OBJECT_ID('dbo.erd_v_order', 'V') IS NOT NULL DROP VIEW dbo.erd_v_order;
IF OBJECT_ID('dbo.erd_order_item', 'U') IS NOT NULL DROP TABLE dbo.erd_order_item;
IF OBJECT_ID('dbo.erd_order', 'U') IS NOT NULL DROP TABLE dbo.erd_order;
IF OBJECT_ID('dbo.erd_product', 'U') IS NOT NULL DROP TABLE dbo.erd_product;
IF OBJECT_ID('dbo.erd_customer', 'U') IS NOT NULL DROP TABLE dbo.erd_customer;
IF OBJECT_ID('dbo.erd_code', 'U') IS NOT NULL DROP TABLE dbo.erd_code;
IF OBJECT_ID('dbo.erd_seq', 'SO') IS NOT NULL DROP SEQUENCE dbo.erd_seq;
GO
CREATE TABLE erd_customer (
  cust_id int IDENTITY(1000,10) NOT NULL,
  cust_cd varchar(20) NOT NULL,
  cust_nm nvarchar(100) NOT NULL,
  grade char(1) NOT NULL DEFAULT ('A'),
  reg_dt datetime2(3) NOT NULL DEFAULT (sysdatetime()),
  CONSTRAINT pk_erd_customer PRIMARY KEY (cust_id),
  CONSTRAINT uq_erd_customer_cd UNIQUE (cust_cd),
  CONSTRAINT ck_erd_customer_grade CHECK (grade IN ('A', 'B', 'C'))
);
CREATE TABLE erd_product (
  prod_cd varchar(20) NOT NULL,
  prod_nm nvarchar(200) NOT NULL,
  price decimal(12,2) NULL,
  memo nvarchar(max) NULL,
  CONSTRAINT pk_erd_product PRIMARY KEY (prod_cd)
);
CREATE TABLE erd_order (
  order_no varchar(20) NOT NULL,
  order_seq int NOT NULL,
  cust_id int NOT NULL,
  order_dt date NOT NULL,
  amount decimal(12,2) NOT NULL DEFAULT ((0)),
  CONSTRAINT pk_erd_order PRIMARY KEY (order_no, order_seq),
  CONSTRAINT fk_erd_order_cust FOREIGN KEY (cust_id) REFERENCES erd_customer (cust_id) ON DELETE CASCADE
);
CREATE TABLE erd_order_item (
  order_no varchar(20) NOT NULL,
  order_seq int NOT NULL,
  item_no int NOT NULL,
  prod_cd varchar(20) NOT NULL,
  qty int NOT NULL,
  qty2 AS (qty * 2) PERSISTED,
  CONSTRAINT pk_erd_order_item PRIMARY KEY (order_no, order_seq, item_no),
  CONSTRAINT fk_erd_item_order FOREIGN KEY (order_no, order_seq) REFERENCES erd_order (order_no, order_seq) ON DELETE CASCADE,
  CONSTRAINT fk_erd_item_prod FOREIGN KEY (prod_cd) REFERENCES erd_product (prod_cd)
);
CREATE TABLE erd_code (
  grp_cd varchar(10) NOT NULL,
  cd varchar(10) NOT NULL,
  cd_nm nvarchar(50) NULL,
  CONSTRAINT pk_erd_code PRIMARY KEY (grp_cd, cd)
);
CREATE INDEX ix_erd_order_cust ON erd_order (cust_id, order_dt);
CREATE UNIQUE INDEX ux_erd_product_nm ON erd_product (prod_nm);
CREATE SEQUENCE erd_seq START WITH 100 INCREMENT BY 10;
EXEC sp_addextendedproperty 'MS_Description', N'거래처', 'SCHEMA', 'dbo', 'TABLE', 'erd_customer';
EXEC sp_addextendedproperty 'MS_Description', N'거래처 코드', 'SCHEMA', 'dbo', 'TABLE', 'erd_customer', 'COLUMN', 'cust_cd';
EXEC sp_addextendedproperty 'MS_Description', N'주문', 'SCHEMA', 'dbo', 'TABLE', 'erd_order';
GO
CREATE VIEW erd_v_order AS SELECT o.order_no, c.cust_nm FROM erd_order o JOIN erd_customer c ON c.cust_id = o.cust_id;
GO
